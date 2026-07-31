#!/usr/bin/env node

// render-epub.js
// Mirrors render-pdf.js's own patch-then-restore approach almost exactly —
// same underlying constraint (Quarto shares one book.chapters: list across
// every output format, so web-only chrome and the letter-prefixed titles
// have to be stripped/patched here rather than in _quarto.yml itself), on
// request to get the EPUB "as close to the PDF as possible." Differences
// from render-pdf.js: none in the patching itself, only in the final
// render command. See render-pdf.js's own header comment for the full
// reasoning behind each of these six patches.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const QUARTO_YML = path.join(__dirname, '_quarto.yml')

const TITLE_STRIPS = [
  ['book/front-preface.qmd', 'title: "P. Preface"', 'title: "Preface"'],
  ['book/front-introduction.qmd', 'title: "I. Introduction"', 'title: "Introduction"'],
  ['book/conclusion.qmd', 'title: "C. Conclusion"', 'title: "Conclusion"'],
  ['book/excursus.qmd', 'title: "E. Excursus"', 'title: "Excursus"'],
]

const RESOURCES_BLOCK = /\n {4}- part: "Resources"\n {6}chapters:\n(?: {8}- .+\n)+/

// Same self-heal as render-pdf.js: a prior run killed before its own
// finally block could run leaves _quarto.yml and these four title files
// stuck mid-patch. Detectable, not preventable — regenerate from source
// (content/*.qmd via the same scripts a clean rebuild uses) rather than
// aborting into a manual diagnosis.
function looksStalePatched() {
  if (!RESOURCES_BLOCK.test(fs.readFileSync(QUARTO_YML, 'utf8'))) return true
  for (const [rel, oldStr] of TITLE_STRIPS) {
    const text = fs.readFileSync(path.join(__dirname, rel), 'utf8')
    if (!text.includes(oldStr)) return true
  }
  return false
}

if (looksStalePatched()) {
  console.log('Detected leftover patched state from a previous interrupted render — regenerating from source before continuing.')
  execSync('node merge-chapters.js --write-quarto', { cwd: __dirname, stdio: 'inherit' })
  execSync('node combine-references.js', { cwd: __dirname, stdio: 'inherit' })
  if (looksStalePatched()) {
    console.error('Auto-regeneration did not resolve it — aborting without further changes. Inspect _quarto.yml and book/{front-preface,front-introduction,conclusion,excursus}.qmd by hand.')
    process.exit(1)
  }
  console.log('Regenerated successfully — continuing with the EPUB render.')
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

// 3. Strip the website's own Table of Contents page
modified = modified.replace(/\n {4}- site\/table-of-contents\.qmd/g, '')

// 4. Strip Reading Guide
modified = modified.replace(/\n {4}- site\/reading-guide\.qmd/g, '')

// 5. Flatten part: wrappers so the EPUB's own TOC has no section-header labels
modified = modified.replace(
  / {4}- part: "[^"]*"\n {6}chapters:\n((?:        - [^\n]+\n)+)/g,
  (_, chapters) => chapters.replace(/^        /gm, '    ')
)

fs.writeFileSync(QUARTO_YML, modified, 'utf8')
console.log('Patched _quarto.yml for EPUB render (stripped Resources + In Plain Terms + website ToC + Reading Guide; flattened parts).')

// 6. Strip letter prefixes from Preface/Introduction/Conclusion/Excursus titles
for (const [rel, oldStr, newStr] of TITLE_STRIPS) {
  const backup = contentBackups.find(b => b.fp === path.join(__dirname, rel))
  fs.writeFileSync(backup.fp, backup.original.replace(oldStr, newStr), 'utf8')
}

console.log('Patched Preface/Introduction/Conclusion/Excursus titles.')

try {
  execSync('quarto render --to epub', { cwd: __dirname, stdio: 'inherit' })
} finally {
  fs.writeFileSync(QUARTO_YML, original, 'utf8')
  for (const backup of contentBackups) {
    fs.writeFileSync(backup.fp, backup.original, 'utf8')
  }
  console.log('Restored title changes.')
  console.log('Restored _quarto.yml.')
}
