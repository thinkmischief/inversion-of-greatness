#!/usr/bin/env node

// render-pdf.js
// Quarto books render the same `book.chapters:` list for every output
// format — there's no per-format chapter list. This script temporarily
// patches _quarto.yml before rendering to PDF:
//   1. Strips the "Resources" part (web-only chrome)
//   2. Strips "In Plain Terms" (web-only; accessible via navbar, not for print)
//   3. Strips the website's own hand-styled "Table of Contents" page — the
//      PDF format already has `toc: true`, which generates its own native
//      LaTeX table of contents. Leaving the website page in as a chapter
//      produced two tables of contents, with the second one appearing as
//      an entry inside the first (its own "Table of Contents" heading
//      showing up as a listed chapter).
//   4. Strips "Reading Guide" (web-only navigation aid — reading settings,
//      shortcuts, AI-reading advice — none of it applies to a printed PDF).
//   5. Flattens part: wrappers so the PDF TOC shows chapters only,
//      without "Front Matter / Chapters / Back Matter" section headers.
//   6. Strips the single-letter prefix ("P. ", "I. ", "C. ", "E. ") from
//      Preface/Introduction/Conclusion/Excursus's own titles — reads as
//      "Preface" rather than "P. Preface" in the PDF specifically. The
//      letter prefixes stay on the website (they match the same A-D
//      scheme Appendices already use there, part of the site's own
//      navigation/numbering system) — this is a print-only preference,
//      on request: "I just wanted to read Preface... this is for the
//      PDF."
// Then restores every file this touched, content included.
//
// Coda ("What God Could the Evidence Allow?") used to need a PDF-only
// H1-promotion hack here to appear as its own table-of-contents entry —
// it lived as an H2 inside book/excursus.qmd. Fixed at the actual source
// instead: its Notion Index property was moved out of the Excursus
// numeric range (merge-chapters.js routes purely by that number), so it
// now generates as its own real chapter file, book/what-god-could-the-
// evidence-allow.qmd, with no format-specific patching needed at all.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const QUARTO_YML = path.join(__dirname, '_quarto.yml')

// file -> [oldTitle, newTitle] — only the leading letter/period/space is
// stripped, nothing else about the title changes.
const TITLE_STRIPS = [
  ['book/front-preface.qmd', 'title: "P. Preface"', 'title: "Preface"'],
  ['book/front-introduction.qmd', 'title: "I. Introduction"', 'title: "Introduction"'],
  ['book/conclusion.qmd', 'title: "C. Conclusion"', 'title: "Conclusion"'],
  ['book/excursus.qmd', 'title: "E. Excursus"', 'title: "Excursus"'],
]

const RESOURCES_BLOCK = /\n {4}- part: "Resources"\n {6}chapters:\n(?: {8}- .+\n)+/

// add-section-anchors.js writes every §N.M cross-reference (prose and the
// entire Subject Index) as [§N.M](chapter-file.html#sec-N-M) — correct for
// the website, where each chapter is its own page, but meaningless for a
// single combined PDF: Pandoc's LaTeX writer sees the ".html" filename and
// emits an external \href to a file that doesn't exist next to the PDF,
// instead of an internal \hyperref resolved within the one document.
// Confirmed live: this is why the PDF Subject Index links (and every §N.M
// cross-reference elsewhere) don't work — reported, logged to the To-Do
// database, fixed here. Stripping the "chapter-file.html" prefix down to
// just "#sec-N-M" is enough: every anchor ID is unique across the whole
// book (it's prefixed by chapter number), so Pandoc resolves the bare
// fragment as an internal cross-reference automatically, in a single
// combined PDF just as much as in one HTML page.
const SECTION_LINK = /\]\([a-z0-9-]+\.html(#sec-[0-9-]+)\)/g

// A prior render-pdf.js run that got killed (Ctrl+C, taskkill, a crash)
// before its own finally block could run leaves _quarto.yml and these
// four title files stuck mid-patch — Node can't run cleanup code after a
// hard kill, so this isn't preventable, only detectable. Rather than
// aborting into a manual "figure out what merge-chapters.js command to
// re-run" diagnosis every time (which happened three separate times in
// one session), self-heal: if either signal of a stale patch is found,
// regenerate _quarto.yml and every book/*.qmd from content/*.qmd (the
// actual source of truth) via the same scripts a clean rebuild uses, then
// re-check once before falling back to the old hard-abort behavior.
// Canary for the SECTION_LINK patch below: book/subject-index.qmd always
// contains many .html#sec- links once add-section-anchors.js has run
// (7994 of them across the book, several hundred in this file alone) — a
// prior interrupted render-pdf.js run can leave them stripped to bare
// #sec- anchors, correct for a PDF but broken on the website.
const SECTION_LINK_CANARY = path.join(__dirname, 'book', 'subject-index.qmd')

function looksStalePatched() {
  if (!RESOURCES_BLOCK.test(fs.readFileSync(QUARTO_YML, 'utf8'))) return true
  for (const [rel, oldStr] of TITLE_STRIPS) {
    const text = fs.readFileSync(path.join(__dirname, rel), 'utf8')
    if (!text.includes(oldStr)) return true
  }
  if (fs.existsSync(SECTION_LINK_CANARY) && !/\.html#sec-/.test(fs.readFileSync(SECTION_LINK_CANARY, 'utf8'))) return true
  return false
}

if (looksStalePatched()) {
  console.log('Detected leftover patched state from a previous interrupted render — regenerating from source before continuing.')
  execSync('node merge-chapters.js --write-quarto', { cwd: __dirname, stdio: 'inherit' })
  // Must run before the canary re-check below — it's what actually writes
  // the .html#sec- links merge-chapters.js alone doesn't produce.
  execSync('node add-section-anchors.js', { cwd: __dirname, stdio: 'inherit' })
  execSync('node combine-references.js', { cwd: __dirname, stdio: 'inherit' })
  if (looksStalePatched()) {
    console.error('Auto-regeneration did not resolve it — aborting without further changes. Inspect _quarto.yml and book/{front-preface,front-introduction,conclusion,excursus}.qmd by hand.')
    process.exit(1)
  }
  console.log('Regenerated successfully — continuing with the PDF render.')
}

const contentBackups = []
for (const [rel, oldStr, newStr] of TITLE_STRIPS) {
  const fp = path.join(__dirname, rel)
  const text = fs.readFileSync(fp, 'utf8')
  if (!text.includes(oldStr)) {
    console.error(`Could not find expected title "${oldStr}" in ${rel} — aborting without changes.`)
    process.exit(1)
  }
  contentBackups.push({ fp, original: text })
}

// Every book/*.qmd gets backed up (not just files known to contain
// §-links) — simpler and safer than tracking which ones do, and the cost
// is a couple dozen small file reads.
const BOOK_DIR = path.join(__dirname, 'book')
const sectionLinkBackups = fs.readdirSync(BOOK_DIR)
  .filter(f => f.endsWith('.qmd'))
  .map(f => {
    const fp = path.join(BOOK_DIR, f)
    return { fp, original: fs.readFileSync(fp, 'utf8') }
  })

const original = fs.readFileSync(QUARTO_YML, 'utf8')

if (!RESOURCES_BLOCK.test(original)) {
  console.error('Could not find the "Resources" part block in _quarto.yml — aborting without changes.')
  process.exit(1)
}

let modified = original

// 1. Strip web-only "Resources" part block
modified = modified.replace(RESOURCES_BLOCK, '\n')

// 2. Strip "In Plain Terms" (web-only page; may appear more than once)
modified = modified.replace(/\n {4}- book\/in-plain-terms\.qmd/g, '')

// 3. Strip the website's own Table of Contents page (see header comment)
modified = modified.replace(/\n {4}- site\/table-of-contents\.qmd/g, '')

// 4. Strip Reading Guide (see header comment)
modified = modified.replace(/\n {4}- site\/reading-guide\.qmd/g, '')

// 5. Flatten part: wrappers so PDF TOC has no section-header labels
modified = modified.replace(
  / {4}- part: "[^"]*"\n {6}chapters:\n((?:        - [^\n]+\n)+)/g,
  (_, chapters) => chapters.replace(/^        /gm, '    ')
)

fs.writeFileSync(QUARTO_YML, modified, 'utf8')
console.log('Patched _quarto.yml for PDF render (stripped Resources + In Plain Terms + website ToC + Reading Guide; flattened parts).')

// 6. Strip letter prefixes from Preface/Introduction/Conclusion/Excursus titles
for (const [rel, oldStr, newStr] of TITLE_STRIPS) {
  const backup = contentBackups.find(b => b.fp === path.join(__dirname, rel))
  fs.writeFileSync(backup.fp, backup.original.replace(oldStr, newStr), 'utf8')
}

console.log('Patched Preface/Introduction/Conclusion/Excursus titles.')

// 7. Strip the "chapter-file.html" prefix from every §N.M cross-reference
// link (see SECTION_LINK's own comment, above) so Pandoc resolves them as
// internal PDF cross-references instead of broken external hyperlinks.
let sectionLinksFixed = 0
for (const backup of sectionLinkBackups) {
  const patched = backup.original.replace(SECTION_LINK, (m, anchor) => {
    sectionLinksFixed++
    return `](${anchor})`
  })
  if (patched !== backup.original) fs.writeFileSync(backup.fp, patched, 'utf8')
}
console.log(`Patched ${sectionLinksFixed} §N.M cross-reference link(s) for PDF (stripped .html chapter-file prefix).`)

try {
  execSync('quarto render --to pdf', { cwd: __dirname, stdio: 'inherit' })
} finally {
  fs.writeFileSync(QUARTO_YML, original, 'utf8')
  for (const backup of contentBackups) {
    fs.writeFileSync(backup.fp, backup.original, 'utf8')
  }
  for (const backup of sectionLinkBackups) {
    fs.writeFileSync(backup.fp, backup.original, 'utf8')
  }
  console.log('Restored title changes.')
  console.log('Restored §N.M cross-reference links.')
  console.log('Restored _quarto.yml.')
}
