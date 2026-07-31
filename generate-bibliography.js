// generate-bibliography.js
// Generates the printed Bibliography chapter (book/bibliography.qmd) directly
// from the References database, instead of from the three hand-typed Notion
// pages (content/references-a-f/g-o/p-z.qmd) that used to be its source.
//
// Why: the database (queried by build-bibliography.js into references.bib,
// used by citeproc to resolve in-text citations) and the three prose pages
// were two independently hand-maintained copies of the same information.
// Confirmed via direct comparison: 691 distinct works are actually cited
// in content/*.qmd, but the old prose pages only listed ~411 — roughly 280
// cited works had no visible bibliography entry a reader could look up.
// This script closes that gap by generating the printed list from exactly
// the set of citekeys actually used in the text, every time.
//
// Requires data/references.json to be current — run `node
// build-bibliography.js` first. Run this after combine-references.js in the
// pipeline; it overwrites whatever that step produced.
//
// Known limitations (by design, not oversight — see each function's own
// comment): author name order is used verbatim from Notion's free-text
// Authors field (not algorithmically re-ordered), and Book Chapter/
// Encyclopedia Entry/Other-type venues render as plain text rather than
// attempting to auto-italicize an embedded book/container title, since
// their raw text isn't structured consistently enough to do that reliably.

const fs = require('fs')
const path = require('path')

const REFERENCES_JSON = path.join(__dirname, 'data', 'references.json')
const CONTENT_DIR = path.join(__dirname, 'content')
const OUT_PATH = path.join(__dirname, 'book', 'bibliography.qmd')

// Same institutional-author detector build-bibliography.js uses for its own
// BibTeX literal-name handling — reused here so an institutional author
// (e.g. "International Theological Commission") sorts by its own full name
// instead of having its last word mistaken for a surname (see sortKey below).
const INSTITUTIONAL_RE = /\b(Institute|Committee|Commission|Organization|Organisation|University|Department|Agency|Office|Council|Society|Foundation|Centers? for|United Nations|World Health|Bureau|Court|Clinic|Vatican|Conference|Forum|Academy|Press\b)\b/i

// Every citation in this book is written as pandoc's [@key] / [-@key], one
// or more per bracket (e.g. "[@a; @b]"). Scans content/*.qmd rather than
// book/*.qmd — content/ is the pre-merge source, so this reflects what's
// actually authored regardless of merge state.
function loadCitedKeys() {
  const cited = new Set()
  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.qmd'))
  const re = /@([A-Za-z][\w:.#$%&\-+?<>~\/]*)/g
  for (const f of files) {
    const text = fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8')
    let m
    while ((m = re.exec(text))) cited.add(m[1].replace(/[:.]+$/, ''))
  }
  return cited
}

// A bibliography sorts by first author's SURNAME, but the Authors field is
// free text entered in whatever order the author typed it — sometimes
// "Last, First" (the comma tells us directly), sometimes plain "First
// Last" for a single author (no comma at all). Institutional authors
// ("International Theological Commission") sort under their own full name,
// not a fabricated "surname". Best-effort: not guaranteed correct for
// suffixes (Jr., III) or multi-word surnames (van der Berg), but far closer
// than not attempting it.
function sortKey(authors) {
  const trimmed = (authors || '').trim()
  if (!trimmed) return ''
  if (INSTITUTIONAL_RE.test(trimmed.split(/[,;]/)[0])) return trimmed.toLowerCase()
  const commaIdx = trimmed.indexOf(',')
  if (commaIdx > 0 && commaIdx < 40) return trimmed.slice(0, commaIdx).toLowerCase()
  // No leading comma: naive "First [Middle] Last" guess for a single
  // author — strip a trailing editor annotation ("(ed.)", "(eds.)", ",
  // ed.") first, since that isn't part of the name and would otherwise
  // get mistaken for the surname itself (e.g. "John Hick (ed.)" without
  // this naively sort-keyed to "(ed.)", filing nowhere near "Hick" —
  // confirmed live: every "<Name> (ed.)"-credited volume floated to the
  // very top of the generated list, ahead of "A").
  const cleaned = trimmed.replace(/\s*,?\s*\(?\s*eds?\.?\)?\s*$/i, '').trim()
  const firstSeg = cleaned.split(/,|;| and /)[0].trim()
  const words = firstSeg.split(/\s+/)
  return (words[words.length - 1] || trimmed).toLowerCase()
}

function cleanVenue(venue) {
  return (venue || '').trim().replace(/\.+$/, '')
}

// Journal Article venues are entered as "Journal Name Vol (Issue): Pages"
// in one free-text field — only the journal-name portion is italicized in
// Chicago style, so this splits at the first token that looks like a
// volume number (starts with a digit).
function splitJournalVenue(venue) {
  const m = venue.match(/^(.+?)\s+(\d.*)$/)
  if (m) return { journal: m[1].trim(), rest: m[2].trim() }
  return { journal: venue, rest: '' }
}

// Chicago style doesn't stack a period after a title that already ends in
// its own terminal punctuation ("Must God Create the Best?." is wrong —
// the quote just closes right after the "?").
function titlePeriod(title) {
  return /[.?!]$/.test(title) ? '' : '.'
}

function formatEntry(row) {
  const authors = (row.Authors || '').trim()
  const year = (row.Year || '').trim()
  const title = (row.Title || '').trim()
  const venue = cleanVenue(row.Venue)
  const type = row.Type || null

  const authorPart = authors ? (authors.endsWith('.') ? authors : authors + '.') : ''
  const lead = [authorPart, year ? year + '.' : ''].filter(Boolean).join(' ')

  if (type === 'Book') {
    const parts = [lead, `*${title}*${titlePeriod(title)}`]
    if (venue) parts.push(venue + '.')
    return parts.filter(Boolean).join(' ')
  }

  if (type === 'Journal Article' && venue) {
    const { journal, rest } = splitJournalVenue(venue)
    const parts = [lead, `“${title}${titlePeriod(title)}”`, rest ? `*${journal}* ${rest}.` : `*${journal}*.`]
    return parts.filter(Boolean).join(' ')
  }

  // Book Chapter, Encyclopedia Entry, Web, Preprint, Other, and no-Type
  // rows all share this shape: quoted title, plain-text venue (see file
  // header comment on why the venue isn't italicized here).
  const parts = [lead, `“${title}${titlePeriod(title)}”`]
  if (venue) parts.push(venue + '.')
  return parts.filter(Boolean).join(' ')
}

function main() {
  if (!fs.existsSync(REFERENCES_JSON)) {
    console.error(`Missing ${path.relative(__dirname, REFERENCES_JSON)} — run 'node build-bibliography.js' first.`)
    process.exit(1)
  }
  const rows = JSON.parse(fs.readFileSync(REFERENCES_JSON, 'utf8'))
  const cited = loadCitedKeys()

  const byKey = new Map()
  for (const r of rows) if (r.Citekey) byKey.set(r.Citekey, r)

  const missing = []
  const used = []
  for (const key of cited) {
    const row = byKey.get(key)
    if (!row) missing.push(key)
    else used.push(row)
  }

  used.sort((a, b) => sortKey(a.Authors).localeCompare(sortKey(b.Authors)) || (a.Year || '').localeCompare(b.Year || ''))

  const entries = used.map(formatEntry)
  const body = entries.join('\n\n') + '\n'
  const frontmatter = '---\ntitle: "Bibliography"\nslug: "bibliography"\nindex: 123000\nrole: apparatus\nbody-classes: references-page back-matter-page\nsearch: false\n---\n\n'

  fs.writeFileSync(OUT_PATH, frontmatter + body, 'utf8')

  console.log(`Wrote ${used.length} entries to ${path.relative(__dirname, OUT_PATH)} (of ${cited.size} cited keys).`)
  if (missing.length) {
    console.warn(`\nWARNING: ${missing.length} cited key(s) not found in the References database — no bibliography entry generated for these:`)
    for (const k of missing) console.warn(`  - ${k}`)
  }
}

main()
