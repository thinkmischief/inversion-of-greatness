// build-bibliography.js
// Pulls the Notion "References" data source and writes references.bib.
//
// The References data source does not show up in the search-based discovery
// that export-notion.js uses (notion.search({filter:{value:'data_source'}})
// never returns it, even though the integration can read it directly by ID —
// this looks like a Notion search-indexing gap, not a permissions issue). So
// this script queries it by data source ID instead of discovering it by title.
//
// Field mapping (per the References database schema):
//   Citekey         -> used verbatim as the BibTeX/CSL key (never regenerated)
//   Authors         -> author (free-text Chicago-style author list, split into
//                       a BibTeX "and"-joined name list; institutional/corporate
//                       authors are kept as one literal name)
//   Title           -> title
//   Year            -> year
//   Venue / Publisher -> journal / publisher+address / booktitle depending on Type
//   Type            -> @book / @article / @incollection / @unpublished /
//                       @inreference / @online / @misc
//   DOI / URL       -> doi or url, whichever the value looks like
//   Public?         -> optional filter via --public-only
//
// Usage:
//   node build-bibliography.js                 # all rows
//   node build-bibliography.js --public-only   # only rows with Public? checked

require('dotenv').config()
const { Client } = require('@notionhq/client')
const fs = require('fs')
const path = require('path')

const notion = new Client({ auth: process.env.NOTION_TOKEN })
const REFERENCES_DATA_SOURCE_ID = '5ee6aa97-6b55-4d09-8e6a-e6b350128311'
const OUT_BIB = path.join(__dirname, 'references.bib')
const OUT_JSON = path.join(__dirname, 'data', 'references.json')
const PUBLIC_ONLY = process.argv.includes('--public-only')

const TYPE_MAP = {
  'Book': 'book',
  'Journal Article': 'article',
  'Book Chapter': 'incollection',
  'Preprint': 'unpublished',
  'Encyclopedia Entry': 'inreference',
  'Web': 'online',
}

function rt(prop) {
  if (!prop) return null
  if (prop.type === 'rich_text') return prop.rich_text.map(t => t.plain_text).join('')
  if (prop.type === 'title') return prop.title.map(t => t.plain_text).join('')
  if (prop.type === 'select') return prop.select?.name ?? null
  if (prop.type === 'checkbox') return prop.checkbox
  if (prop.type === 'url') return prop.url
  return null
}

async function fetchRows() {
  const all = []
  let cursor
  do {
    const r = await notion.dataSources.query({
      data_source_id: REFERENCES_DATA_SOURCE_ID,
      start_cursor: cursor,
      page_size: 100,
    })
    all.push(...r.results)
    cursor = r.has_more ? r.next_cursor : undefined
  } while (cursor)

  return all.map(page => ({
    id: page.id,
    Citekey: rt(page.properties['Citekey']),
    Authors: rt(page.properties['Authors']),
    Title: rt(page.properties['Title']),
    Year: rt(page.properties['Year']),
    Venue: rt(page.properties['Venue / Publisher']),
    Type: rt(page.properties['Type']),
    DOI: rt(page.properties['DOI / URL']),
    Public: rt(page.properties['Public?']),
  }))
}

const INSTITUTIONAL_RE = /\b(Institute|Committee|Commission|Organization|Organisation|University|Department|Agency|Office|Council|Society|Foundation|Centers? for|United Nations|World Health|Bureau|Court|Clinic|Vatican|Conference|Forum|Academy|Press\b)\b/i

// A comma-separated token continues the previous token into a "Last, First"
// pair when it looks like a given name / initials rather than a complete
// standalone "First Last" name.
function isGivenNameContinuation(token) {
  const words = token.trim().split(/\s+/)
  const last = words[words.length - 1]
  if (last.endsWith('.')) return true
  if (words.length === 1) return true
  return false
}

// "Et al." in a Notion Authors field means "and other, unlisted authors" —
// not a literal name. Strip it and signal the caller to append the BibTeX/
// CSL "others" sentinel, which citeproc renders as "et al." correctly
// (instead of mis-parsing "al." as a surname, e.g. "Riess et al." ->
// family "al.", given "Riess et").
const ET_AL_RE = /,?\s*et\.?\s*al\.?\s*$/i

function splitAuthors(raw) {
  if (!raw || !raw.trim()) return { people: [], literal: null }

  let s = raw.trim()
  const hasEtAl = ET_AL_RE.test(s)
  if (hasEtAl) s = s.replace(ET_AL_RE, '').trim()

  if (!s) return { people: hasEtAl ? ['others'] : [], literal: null }

  if (s.includes(';') || INSTITUTIONAL_RE.test(s)) {
    // Corporate/institutional author, or already-structured with semicolons
    // (e.g. "Commission on X (WHO); chaired by Y") — keep as one literal name.
    const literal = s.replace(/\(eds?\.\)\s*$/i, '').replace(/,?\s*eds?\.\s*$/i, '').trim()
    return { people: hasEtAl ? [`{${bibEscape(literal)}}`, 'others'] : [], literal: hasEtAl ? null : literal }
  }

  s = s.replace(/\(eds?\.\)\s*$/i, '').replace(/,?\s*eds?\.\s*$/i, '').trim().replace(/,\s*$/, '')
  s = s.replace(/,\s*and\s+/gi, '; ').replace(/\s+and\s+/gi, '; ')

  const groups = s.split(';').map(g => g.trim()).filter(Boolean)
  const people = []
  for (const group of groups) {
    const tokens = group.split(',').map(t => t.trim()).filter(Boolean)
    let i = 0
    while (i < tokens.length) {
      if (i + 1 < tokens.length && isGivenNameContinuation(tokens[i + 1])) {
        people.push(`${tokens[i]}, ${tokens[i + 1]}`)
        i += 2
      } else {
        people.push(tokens[i])
        i += 1
      }
    }
  }
  if (hasEtAl) people.push('others')
  return { people, literal: null }
}

function bibEscape(s) {
  return String(s).replace(/[{}]/g, '')
}

function authorField(raw) {
  const { people, literal } = splitAuthors(raw)
  if (literal) return `{${bibEscape(literal)}}`
  if (!people.length) return null
  return people.map(p => (p.startsWith('{') && p.endsWith('}')) ? p : bibEscape(p)).join(' and ')
}

// "Cambridge: Cambridge University Press" -> { address, publisher }
function splitVenue(venue) {
  const m = /^([^:]{2,40}):\s*(.+)$/.exec(venue || '')
  if (m && !/\d/.test(m[1])) return { address: m[1].trim(), publisher: m[2].trim() }
  return { address: null, publisher: venue || null }
}

function buildFields(row) {
  const fields = {}
  const type = TYPE_MAP[row.Type] || 'misc'

  if (row.Title) fields.title = bibEscape(row.Title)
  if (row.Year) fields.year = bibEscape(row.Year)

  const author = authorField(row.Authors)
  if (author) fields.author = author

  if (row.Venue) {
    if (type === 'article') {
      fields.journal = bibEscape(row.Venue)
    } else if (type === 'incollection' || type === 'inreference') {
      fields.booktitle = bibEscape(row.Venue)
    } else if (type === 'online' || type === 'unpublished') {
      fields.note = bibEscape(row.Venue)
    } else {
      const { address, publisher } = splitVenue(row.Venue)
      if (publisher) fields.publisher = bibEscape(publisher)
      if (address) fields.address = bibEscape(address)
      if (!publisher && !address) fields.note = bibEscape(row.Venue)
    }
  }

  // "DOI / URL" is a combined Notion field — a real DOI, a real URL, or
  // (confirmed live, 14 references) plain text like "ISBN 9780156010757"
  // that's neither. Treating anything non-DOI-shaped as a URL unconditionally
  // produced a broken https://ISBN 9780156010757 link in the rendered
  // bibliography — an ISBN isn't a fetchable address on its own, so rather
  // than guess at a lookup-service URL to wrap it in, this just drops it:
  // no doi/url field at all means citeproc renders the reference as plain
  // text, which is what these entries already read as either way.
  if (row.DOI) {
    if (/^10\.\S+/.test(row.DOI)) fields.doi = row.DOI
    else if (/^https?:\/\//.test(row.DOI)) fields.url = row.DOI
  }

  return { type, fields }
}

function toBibEntry(row) {
  const { type, fields } = buildFields(row)
  const lines = Object.entries(fields).map(([k, v]) => `  ${k} = {${v}}`)
  return `@${type}{${row.Citekey},\n${lines.join(',\n')}\n}`
}

async function main() {
  if (!process.env.NOTION_TOKEN) {
    console.error('Missing NOTION_TOKEN in .env')
    process.exit(1)
  }

  console.log('Fetching References database...')
  const rows = await fetchRows()
  console.log(`Fetched ${rows.length} rows.`)

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
  fs.writeFileSync(OUT_JSON, JSON.stringify(rows, null, 2))

  const missingCitekey = rows.filter(r => !r.Citekey)
  if (missingCitekey.length) {
    console.warn(`WARNING: ${missingCitekey.length} row(s) have no Citekey — skipping:`)
    for (const r of missingCitekey) console.warn(`  - ${r.Title || r.id}`)
  }

  let usable = rows.filter(r => r.Citekey)
  if (PUBLIC_ONLY) {
    const before = usable.length
    usable = usable.filter(r => r.Public === true)
    console.log(`--public-only: kept ${usable.length} of ${before} rows.`)
  }

  // De-duplicate citekeys (same key entered more than once in Notion):
  // keep the more complete row (more populated fields wins; Public ties broken
  // in favor of true).
  const byKey = new Map()
  for (const r of usable) {
    const existing = byKey.get(r.Citekey)
    if (!existing) {
      byKey.set(r.Citekey, r)
      continue
    }
    const score = x => Object.values(x).filter(v => v != null && v !== '').length + (x.Public ? 1 : 0)
    if (score(r) > score(existing)) byKey.set(r.Citekey, r)
  }
  const deduped = [...byKey.values()].sort((a, b) => a.Citekey.localeCompare(b.Citekey))
  const dupCount = usable.length - deduped.length
  if (dupCount) console.warn(`WARNING: collapsed ${dupCount} duplicate citekey row(s).`)

  const bib = deduped.map(toBibEntry).join('\n\n') + '\n'
  fs.writeFileSync(OUT_BIB, bib, 'utf8')

  console.log(`Wrote ${deduped.length} entries to ${path.relative(__dirname, OUT_BIB)}`)
}

main().catch(err => {
  console.error('\nFailed:', err.message)
  process.exit(1)
})
