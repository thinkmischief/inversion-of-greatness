// export-bib.js
// Queries the Notion References database and writes references.bib.
// Also saves data/references.json as a side effect for auditing.
//
// The References data source is invisible to notion.search() — must be
// queried directly by its data_source_id (stored below).

require('dotenv').config()
const { Client } = require('@notionhq/client')
const fs   = require('fs')
const path = require('path')

const notion = new Client({ auth: process.env.NOTION_TOKEN })

const REFERENCES_DS_ID = '5ee6aa97-6b55-4d09-8e6a-e6b350128311'
const BIB_PATH  = path.join(__dirname, 'references.bib')
const JSON_PATH = path.join(__dirname, 'data', 'references.json')

// ── Helpers ────────────────────────────────────────────────────────────────────

function getProp(page, name) {
  const p = page.properties?.[name]
  if (!p) return null
  switch (p.type) {
    case 'title':      return p.title.map(t => t.plain_text).join('').trim() || null
    case 'rich_text':  return p.rich_text.map(t => t.plain_text).join('').trim() || null
    case 'select':     return p.select?.name ?? null
    case 'number':     return p.number ?? null
    case 'checkbox':   return p.checkbox
    case 'url':        return p.url ?? null
    case 'date':       return p.date?.start ?? null
    default:           return null
  }
}

async function queryAll(dataSourceId) {
  const all = []
  let cursor
  do {
    const r = await notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      page_size: 100,
    })
    all.push(...r.results)
    cursor = r.has_more ? r.next_cursor : undefined
  } while (cursor)
  return all
}

// Strip BibTeX special chars from field values
function bibEscape(s) {
  return (s || '').replace(/[{}\\]/g, c => c === '\\' ? '\\\\' : '\\' + c)
}

function field(name, value) {
  if (!value && value !== 0) return null
  return `  ${name} = {${bibEscape(String(value))}},`
}

function toBibType(notionType) {
  switch (notionType) {
    case 'Journal Article': return 'article'
    case 'Book':            return 'book'
    case 'Book Chapter':
    case 'Encyclopedia Entry': return 'incollection'
    case 'Preprint':        return 'misc'
    case 'Web':             return 'misc'
    default:                return 'misc'
  }
}

function toBibEntry(row) {
  const rawKey = (row.Citekey || '').replace(/^@+/, '').trim()
  if (!rawKey) return null

  const bibType = toBibType(row.Type)
  const venue   = row.Venue || ''

  const venueField = bibType === 'article'
    ? field('journal', venue)
    : bibType === 'book'
      ? field('publisher', venue)
      : bibType === 'incollection'
        ? field('booktitle', venue)
        : field('publisher', venue)  // misc/unpublished

  const lines = [
    `@${bibType}{${rawKey},`,
    field('title',  row.Title),
    field('year',   row.Year),
    field('author', row.Authors),
    venueField,
    field('url',    row.DOI),
    '}',
  ].filter(Boolean)

  return lines.join('\n')
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.NOTION_TOKEN) {
    console.error('Missing NOTION_TOKEN'); process.exit(1)
  }

  console.log('Querying Notion References database...')
  const pages = await queryAll(REFERENCES_DS_ID)
  console.log(`${pages.length} reference entries retrieved.`)

  // Build simplified rows (mirrors data/references.json schema)
  const rows = pages.map(p => ({
    id:      p.id,
    Citekey: getProp(p, 'Citekey'),
    Authors: getProp(p, 'Authors'),
    Title:   getProp(p, 'Title'),
    Year:    getProp(p, 'Year'),
    Venue:   getProp(p, 'Venue'),
    Type:    getProp(p, 'Type'),
    DOI:     getProp(p, 'DOI'),
    Public:  getProp(p, 'Public'),
  })).filter(r => r.Citekey)

  // Save JSON for auditing / other scripts
  fs.writeFileSync(JSON_PATH, JSON.stringify(rows, null, 2) + '\n', 'utf8')
  console.log(`Saved ${rows.length} rows → data/references.json`)

  // Warn about citekeys with erroneous leading @
  const badKeys = rows.filter(r => r.Citekey.startsWith('@'))
  if (badKeys.length) {
    console.warn(`WARN ${badKeys.length} citekey(s) have a leading "@" in Notion — stripping it:`)
    badKeys.forEach(r => console.warn(`  ${r.Citekey}`))
  }

  // Generate BibTeX
  let ok = 0, skipped = 0
  const bibEntries = []
  for (const row of rows) {
    const entry = toBibEntry(row)
    if (!entry) { skipped++; continue }
    bibEntries.push(entry)
    ok++
  }

  fs.writeFileSync(BIB_PATH, bibEntries.join('\n\n') + '\n', 'utf8')
  console.log(`Wrote ${ok} entries → references.bib${skipped ? ` (${skipped} skipped: no citekey)` : ''}`)
}

main().catch(err => { console.error('export-bib failed:', err.message); process.exit(1) })
