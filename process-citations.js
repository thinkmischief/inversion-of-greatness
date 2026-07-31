// process-citations.js
// Merged replacement for expand-footnote-cites.js + number-citations.js.
// One pass per file, one bib load for the whole run.
//
// What it does:
//   1. ALL book/*.qmd — expands [@key] inside existing [^id]: footnote
//      definitions to full formatted citations (Notion-authored notes).
//   2. Chapter files only (0N-*.qmd) — converts [@key] in body prose to
//      numbered [^chapname-ci-N] markers and appends the full citation
//      definitions at the end. collect-notes.js then harvests those for
//      the Notes page.
//   Text-mode @key citations (no brackets) are left for citeproc.
//
// Pipeline position: after merge-chapters.js, before collect-notes.js.

const fs   = require('fs')
const path = require('path')

const BOOK_DIR = path.join(__dirname, 'book')
const BIB_PATH = path.join(__dirname, 'references.bib')

if (!fs.existsSync(BIB_PATH)) {
  console.error('process-citations: missing references.bib')
  process.exit(1)
}

// ── BibTeX parser ─────────────────────────────────────────────────────────────

function parseBib(text) {
  const entries = {}
  const entryRe = /@(\w+)\{([^,]+),\s*([\s\S]*?)\n\}/g
  let m
  while ((m = entryRe.exec(text)) !== null) {
    const type   = m[1].toLowerCase()
    const key    = m[2].trim()
    const body   = m[3]
    const fields = {}
    const fieldRe = /(\w+)\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g
    let f
    while ((f = fieldRe.exec(body)) !== null) {
      fields[f[1].toLowerCase()] = f[2].trim()
    }
    entries[key] = { type, key, ...fields }
  }
  return entries
}

// ── Citation formatting ───────────────────────────────────────────────────────

function formatAuthors(raw) {
  if (!raw) return ''
  return raw.split(/\s+and\s+/).map((a, i) => {
    const t = a.trim()
    if (i === 0) return t
    const parts = t.split(',')
    if (parts.length >= 2) return `${parts.slice(1).join(',').trim()} ${parts[0].trim()}`
    return t
  }).join(', ')
}

function clean(s) {
  return s.replace(/\s+\./g, '.').replace(/\.{2,}/g, '.').trim()
}

function formatEntry(entry) {
  const author    = formatAuthors(entry.author)
  const year      = entry.year      || ''
  const title     = entry.title     || ''
  const publisher = entry.publisher || ''
  const address   = entry.address   || ''
  // Strip any embedded volume/page numbers from the journal field
  const journal   = (entry.journal || entry.journaltitle || '').replace(/\s+\d[\d():\s–\-]*$/, '').trim()
  const volume    = entry.volume    || ''
  const number    = entry.number    || ''
  const pages     = (entry.pages    || '').replace(/--/g, '–')
  const editor    = formatAuthors(entry.editor || '')
  const booktitle = entry.booktitle || ''
  const location  = address ? `${address}: ` : ''

  switch (entry.type) {
    case 'article': {
      const vol = volume + (number ? `(${number})` : '') + (pages ? `: ${pages}` : '')
      return clean(`${author}. ${year}. "${title}." *${journal}* ${vol}.`)
    }
    case 'incollection':
    case 'inbook': {
      const ed = editor ? `, edited by ${editor}` : ''
      return clean(`${author}. ${year}. "${title}." In *${booktitle}*${ed}. ${location}${publisher}.`)
    }
    case 'phdthesis':
    case 'mastersthesis': {
      const institution = entry.institution || publisher
      return clean(`${author}. ${year}. "${title}." PhD diss., ${institution}.`)
    }
    default:
      return clean(`${author}. ${year}. *${title}*. ${location}${publisher}.`)
  }
}

// Formats a [@key] or [@key, locator] or [@k1; @k2] group as inline text.
// Used for expanding citations already inside footnote definitions.
function expandBracketGroup(content, bib) {
  const parts = content.split(/\s*;\s*/).map(part => {
    const commaIdx = part.indexOf(',')
    const rawKey   = (commaIdx >= 0 ? part.slice(0, commaIdx) : part).trim().replace(/^@/, '')
    const locator  = commaIdx >= 0 ? part.slice(commaIdx + 1).trim() : ''
    const entry    = bib[rawKey]
    if (!entry) return `[@${part.trim()}]`
    const full = formatEntry(entry)
    return locator ? full.replace(/\.$/, '') + ', ' + locator + '.' : full
  })
  return parts.join('; ')
}

// Formats a set of {key, locator} pairs for appending as a footnote definition.
function formatCitation(keys, bib) {
  return keys.map(({ key, locator }) => {
    const entry = bib[key]
    if (!entry) return `[@${key}]`
    const full = formatEntry(entry)
    return locator ? full.replace(/\.$/, '') + ', ' + locator + '.' : full
  }).join('; ')
}

// ── File processor ────────────────────────────────────────────────────────────

function processFile(fp, bib, isChapter) {
  const orig  = fs.readFileSync(fp, 'utf8')
  const lines = orig.split('\n')

  const chapterId = path.basename(fp, '.qmd')
  let   counter   = 1
  const keyToNum  = new Map()
  const newDefs   = []
  let   defLinesChanged = 0

  const processed = lines.map(line => {
    // ── Footnote definition lines: expand [@key] to full citation text ──
    if (/^\[\^[^\]]+\]:/.test(line)) {
      const expanded = line
        .replace(/\[@([^\]]+)\]/g, (_, content) => expandBracketGroup(content, bib))
        .replace(/\.\s*\./g, '.')
        .replace(/\.\s*;/g, ';')
      if (expanded !== line) defLinesChanged++
      return expanded
    }

    // ── Body prose (chapters only): convert [@key] to numbered markers ──
    if (!isChapter) return line
    if (/^---/.test(line)) return line  // skip YAML frontmatter

    return line.replace(/\[@([^\]]+)\]/g, (_match, content) => {
      const keys      = content.split(/\s*;\s*/).map(part => {
        const ci    = part.indexOf(',')
        return { key: (ci >= 0 ? part.slice(0, ci) : part).trim().replace(/^@/, ''),
                 locator: ci >= 0 ? part.slice(ci + 1).trim() : '' }
      })
      const valid = keys.filter(({ key }) => bib[key])
      if (!valid.length) return _match

      const groupKey = content.trim()
      if (!keyToNum.has(groupKey)) {
        const num   = counter++
        keyToNum.set(groupKey, num)
        newDefs.push(`[^${chapterId}-ci-${num}]: ${formatCitation(valid, bib)}`)
      }
      return `[^${chapterId}-ci-${keyToNum.get(groupKey)}]`
    })
  })

  const changed = defLinesChanged > 0 || newDefs.length > 0
  if (!changed) return { defLines: 0, inlineCites: 0 }

  const output = processed.join('\n').trimEnd()
    + (newDefs.length ? '\n\n' + newDefs.join('\n') : '')
    + '\n'
  fs.writeFileSync(fp, output, 'utf8')
  return { defLines: defLinesChanged, inlineCites: newDefs.length }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const bib = parseBib(fs.readFileSync(BIB_PATH, 'utf8'))
  console.log(`process-citations: loaded ${Object.keys(bib).length} bib entries.`)

  const files = fs.readdirSync(BOOK_DIR)
    .filter(f => f.endsWith('.qmd'))
    .sort()

  let totalDef = 0, totalInline = 0, filesChanged = 0

  for (const fn of files) {
    const isChapter = /^0[1-9]-/.test(fn)
    const { defLines, inlineCites } = processFile(path.join(BOOK_DIR, fn), bib, isChapter)
    if (defLines || inlineCites) {
      const parts = []
      if (defLines)    parts.push(`${defLines} footnote def(s) expanded`)
      if (inlineCites) parts.push(`${inlineCites} inline citation(s) numbered`)
      console.log(`  ${fn}: ${parts.join(', ')}`)
      filesChanged++
      totalDef    += defLines
      totalInline += inlineCites
    }
  }

  console.log(`Done. ${totalDef} footnote def(s) + ${totalInline} inline citation(s) across ${filesChanged} file(s).`)
}

main()
