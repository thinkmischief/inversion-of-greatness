// attach-margin-notes.js
//
// Pulls "Placed" / "Margin note" rows from the Annotation database
// (Notion) and inserts each one as a Quarto native margin block
// (::: {.column-margin} ... :::) into the content/*.qmd section file
// its own Section relation points to, right after the paragraph
// containing its Anchor text.
//
// Scoped deliberately narrow: Status = "Placed" (Notion's own
// "reviewed and confirmed" status, not just drafted-and-hopeful) and
// Form = "Margin note" only. The Annotation database also has
// Footnote/Inline gloss/Sidebar/Callout forms and Draft/Ready/Cut
// statuses — those are out of scope here on purpose. Known, already-
// logged problems this scope sidesteps: 90 "Ready" annotations are
// missing an Anchor entirely (can't be placed without one), 15 of 32
// "Ready" annotations describe an outdated version of the argument
// (flagged stale in Notion), and Chapters 5-8/appendices/back matter
// have zero entries of any status yet.
//
// Runs right after export-pages.js, before merge-chapters.js —
// content/*.qmd is freshly Notion-exported prose at this point, not
// yet assembled into a book/*.qmd chapter, so the insertion only has
// to find text within one section's own content, and every later
// pipeline step (cross-references, section anchors, prose fixing)
// sees the margin block as if it had always been there. Like
// link-table-of-contents.js, this makes no permanent change to any
// Notion-sourced file in principle — but export-pages.js's own export
// is incremental (keyed on Notion's last_edited_time) unless run with
// --all, so content/*.qmd is NOT guaranteed fresh on a plain rebuild.
// Insertion is therefore idempotent on the formatted note body itself
// (see the `text.includes(noteBody)` check below), so reruns against
// already-annotated, unrefreshed content skip rather than duplicate.

require('dotenv').config()
const { Client } = require('@notionhq/client')
const fs = require('fs')
const path = require('path')

const notion = new Client({ auth: process.env.NOTION_TOKEN })
const CONTENT_DIR = path.join(__dirname, 'content')

function rt(arr) {
  if (!arr || !arr.length) return ''
  return arr.map(t => {
    let s = t.plain_text
    const a = t.annotations || {}
    if (a.code) s = '`' + s + '`'
    if (a.bold) s = '**' + s + '**'
    if (a.italic) s = '*' + s + '*'
    if (a.strikethrough) s = '~~' + s + '~~'
    if (t.href) s = '[' + s + '](' + t.href + ')'
    return s
  }).join('')
}

function getPropString(page, name) {
  const p = page.properties?.[name]
  if (!p) return null
  if (p.type === 'rich_text') return rt(p.rich_text) || null
  if (p.type === 'title') return rt(p.title) || null
  if (p.type === 'select') return p.select?.name ?? null
  return null
}

function getPropRelationId(page, name) {
  const p = page.properties?.[name]
  if (!p || p.type !== 'relation' || !p.relation?.length) return null
  return p.relation[0].id
}

async function findDataSource(name) {
  let cursor
  do {
    const r = await notion.search({
      filter: { property: 'object', value: 'data_source' },
      start_cursor: cursor, page_size: 100,
    })
    const found = r.results.find(d => {
      const t = (d.title || []).map(x => x.plain_text).join('').trim()
      return t === name || t.toLowerCase() === name.toLowerCase() || t.endsWith(name)
    })
    if (found) return found
    cursor = r.has_more ? r.next_cursor : undefined
  } while (cursor)
  return null
}

async function queryAll(dataSourceId, filter) {
  const all = []
  let cursor
  do {
    const r = await notion.dataSources.query({
      data_source_id: dataSourceId,
      filter,
      start_cursor: cursor, page_size: 100,
    })
    all.push(...r.results)
    cursor = r.has_more ? r.next_cursor : undefined
  } while (cursor)
  return all
}

// Where to insert relative to the anchor's own paragraph — NOT
// always "the next blank line after it." An anchor that sits inside
// a semantic block (::: {.argument}, {.definition}, {.theorem}, a
// numbered premise list, etc.) has blank lines of its OWN between
// premises, so the naive "next \n\n" landed the margin note INSIDE
// that block instead of after it — confirmed live: a real chapter
// file came out with the inserted ::: {.column-margin} nested one
// level inside a ::: {.argument} block, its closing fence pushed
// past the outer block's own close. Balanced Pandoc fenced-div
// syntax (this codebase's own blocks all close on a bare ":::" line
// regardless of how many colons opened them, so the SAME 3-colon
// count opening/closing at different nesting depths still parses,
// LIFO), so it wasn't actually a parse error — but it's still the
// margin note landing wherever the block's OWN internal structure
// happened to have a blank line, not deliberately after the block
// that contains its anchor. This tracks fence-open/close lines with
// a simple depth counter: if the anchor sits inside N open divs,
// the insertion point is pushed forward to where the outermost one
// of those N actually closes, not the first blank line encountered
// along the way.
function findInsertionPoint(text, anchorIdx) {
  const lines = text.split('\n')
  let offset = 0, depth = 0, anchorLine = -1, depthAtAnchor = 0
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = offset + lines[i].length
    if (anchorLine === -1 && anchorIdx >= offset && anchorIdx <= lineEnd) {
      anchorLine = i
      depthAtAnchor = depth
    }
    if (/^:::+\s*\{/.test(lines[i])) depth++
    else if (/^:::+\s*$/.test(lines[i])) depth = Math.max(0, depth - 1)
    offset = lineEnd + 1
  }
  if (depthAtAnchor === 0) {
    const nb = text.indexOf('\n\n', anchorIdx)
    return nb === -1 ? text.length : nb
  }
  let d = depthAtAnchor
  offset = 0
  for (let i = 0; i <= anchorLine; i++) offset += lines[i].length + 1
  for (let i = anchorLine + 1; i < lines.length; i++) {
    if (/^:::+\s*\{/.test(lines[i])) d++
    else if (/^:::+\s*$/.test(lines[i])) {
      d--
      if (d <= 0) return offset + lines[i].length + 1
    }
    offset += lines[i].length + 1
  }
  return text.length
}

// Bold just the leading "{Lead-in}." sentence already embedded as
// Content's own first sentence (confirmed live against real rows —
// e.g. Content: "Core concept. By this point..." for Lead-in: "Core
// concept") rather than prepending the Lead-in property as a second,
// duplicate label — the schema's own description says as much
// ("the visible label should usually appear in bold at the start of
// Content"). Falls back to the plain, unbolded content on the rare
// row where the pattern doesn't hold (no period found early enough
// to plausibly be a lead-in sentence).
function formatMarginNote(content) {
  const m = content.match(/^([A-Z][^.]{2,40}\.)\s+(.+)$/s)
  if (!m) return content
  return `**${m[1]}** ${m[2]}`
}

async function main() {
  const ds = await findDataSource('Annotation')
  if (!ds) {
    console.error('attach-margin-notes: could not find the Annotation data source — skipping.')
    return
  }
  const dataSourceId = ds.id

  const rows = await queryAll(dataSourceId, {
    and: [
      { property: 'Status', status: { equals: 'Placed' } },
      { property: 'Form', select: { equals: 'Margin note' } },
    ],
  })

  // notion-id -> absolute file path, scanned once from every
  // content/*.qmd's own frontmatter (the same field export-pages.js
  // writes for every page it exports).
  const idToFile = new Map()
  for (const file of fs.readdirSync(CONTENT_DIR)) {
    if (!file.endsWith('.qmd')) continue
    const filePath = path.join(CONTENT_DIR, file)
    const text = fs.readFileSync(filePath, 'utf8')
    const m = text.match(/^notion-id:\s*([0-9a-f-]{32,36})/m)
    if (m) idToFile.set(m[1].replace(/-/g, ''), filePath)
  }

  // Group by target file so multiple notes in the same section apply
  // in one read-modify-write pass, each insertion searching the
  // CURRENT (already-modified-by-earlier-insertions-in-this-file)
  // text, not a stale copy.
  const byFile = new Map()
  let noSectionMatch = 0, noAnchor = 0, noAnchorMatch = 0

  for (const row of rows) {
    const anchor = getPropString(row, 'Anchor')
    if (!anchor) { noAnchor++; continue }
    const sectionId = getPropRelationId(row, 'Section')
    const filePath = sectionId ? idToFile.get(sectionId.replace(/-/g, '')) : null
    if (!filePath) {
      noSectionMatch++
      console.warn(`  no matching content/*.qmd for Section ${sectionId} (annotation: "${getPropString(row, 'Annotation')}")`)
      continue
    }
    const content = getPropString(row, 'Content') || ''
    if (!byFile.has(filePath)) byFile.set(filePath, [])
    byFile.get(filePath).push({ anchor, content, annotation: getPropString(row, 'Annotation') })
  }

  let inserted = 0
  for (const [filePath, notes] of byFile) {
    let text = fs.readFileSync(filePath, 'utf8')
    for (const note of notes) {
      const idx = text.indexOf(note.anchor)
      if (idx === -1) {
        noAnchorMatch++
        console.warn(`  anchor not found in ${path.basename(filePath)}: "${note.anchor.slice(0, 60)}..." (annotation: "${note.annotation}")`)
        continue
      }
      const noteBody = formatMarginNote(note.content)
      if (text.includes(noteBody)) continue // already placed by an earlier run against unrefreshed content
      const insertAt = findInsertionPoint(text, idx)
      // .book-annotation-note alongside .column-margin — a second,
      // distinguishing class so the reader-facing show/hide toggle
      // (resources/book-scripts.html) can target exactly these
      // Annotation-database notes without also hiding any other
      // unrelated .column-margin content (figure captions, etc.).
      const block = `\n\n::: {.column-margin .book-annotation-note}\n${noteBody}\n:::\n`
      text = text.slice(0, insertAt) + block + text.slice(insertAt)
      inserted++
    }
    fs.writeFileSync(filePath, text)
  }

  console.log(`attach-margin-notes: ${inserted} inserted, ${noAnchor} skipped (no Anchor), ${noSectionMatch} skipped (Section has no matching file), ${noAnchorMatch} skipped (Anchor text not found in target file).`)
}

main().catch(e => { console.error(e); process.exit(1) })
