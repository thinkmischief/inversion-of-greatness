// collect-notes.js
// Generates book/notes.qmd by collecting all expanded footnote definitions
// from the book's main-text chapter files in reading order. Runs after
// expand-footnote-cites.js so citations are already in full-reference form.
//
// Output: a back-matter page with one ## section per chapter, each containing
// a numbered list of that chapter's footnotes.
//
// Pipeline position: after expand-footnote-cites.js, before fix-cross-references.js.

const fs   = require('fs')
const path = require('path')

const BOOK_DIR   = path.join(__dirname, 'book')
const QUARTO_YML = path.join(__dirname, '_quarto.yml')
const OUT_FILE   = path.join(BOOK_DIR, 'notes.qmd')

// ── Read chapter files in chapter order from _chapter-map.json ───────────────

function getChapterFilesInOrder() {
  const mapFile = path.join(BOOK_DIR, '_chapter-map.json')
  if (!fs.existsSync(mapFile)) return []
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'))
  return Object.keys(map)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map(k => map[k].replace(/\.html$/, '.qmd'))
}

// ── Extract frontmatter title from a .qmd file ───────────────────────────────

function getTitle(text) {
  const m = text.match(/^---\n[\s\S]*?^title:\s*"([^"]+)"/m)
  return m ? m[1] : null
}

// ── Extract footnote definitions from a .qmd file ────────────────────────────
// Returns an array of { id, content } objects for lines like:
//   [^5-1-2-1]: Oppy, Graham. 2006. *Arguing about Gods*. Cambridge UP.

function getFootnotes(text) {
  const notes = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\[\^([^\]]+)\]:\s*(.+)$/)
    if (m) notes.push({ id: m[1], content: m[2].trim() })
  }
  return notes
}

// ── Build the Notes page content ──────────────────────────────────────────────

function buildNotes() {
  const chapterFiles = getChapterFilesInOrder()
  const sections     = []

  for (const fn of chapterFiles) {
    const fp = path.join(BOOK_DIR, fn)
    if (!fs.existsSync(fp)) continue

    const text      = fs.readFileSync(fp, 'utf8')
    const title     = getTitle(text)
    const footnotes = getFootnotes(text)

    if (!footnotes.length) continue  // chapter has no notes — skip

    // Real ## heading for HTML (keeps these reachable from the page's own
    // "Page Contents" in-page nav), but bold plain text — not a heading at
    // all — for PDF, via this project's existing content-visible pattern
    // (same technique book/style-preview.qmd already uses for its OJS
    // chart). {-} (unnumbered) was tried first and didn't work: confirmed
    // live that Quarto's LaTeX output still adds a \tableofcontents entry
    // for an unnumbered heading regardless — number-sections: false only
    // ever suppressed the "1.2.3" prefix, never inclusion itself. On
    // request: the PDF's table of contents should show one "Notes" entry,
    // not a further breakdown by chapter underneath it. A non-heading
    // element can never generate a TOC entry in any format, sidestepping
    // the whole question of what does or doesn't get excluded.
    const headingText = title || fn
    const lines = [
      '::: {.content-visible when-format="html"}',
      `## ${headingText}`,
      ':::',
      '',
      '::: {.content-visible unless-format="html"}',
      `**${headingText}**`,
      ':::',
      '',
    ]
    footnotes.forEach((n, i) => lines.push(`${i + 1}. ${n.content}`))
    lines.push('')
    sections.push(lines.join('\n'))
  }

  return sections.join('\n')
}

// ── Write book/notes.qmd ─────────────────────────────────────────────────────

const frontmatter = [
  '---',
  'title: "Notes"',
  'slug: "notes"',
  'body-classes: notes-page back-matter-page',
  'search: false',
  '---',
  '',
  '',
].join('\n')

const body = buildNotes()

if (!body.trim()) {
  console.log('collect-notes: no footnotes found in any chapter — notes.qmd not written.')
  process.exit(0)
}

fs.writeFileSync(OUT_FILE, frontmatter + body, 'utf8')

const chapterCount = (body.match(/^## /gm) || []).length
const noteCount    = (body.match(/^\d+\. /gm) || []).length
console.log(`collect-notes: ${noteCount} note(s) across ${chapterCount} chapter(s) → ${path.relative(__dirname, OUT_FILE)}`)
