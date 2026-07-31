// fix-cross-references.js
// Rewrites ch01.html#sec-X-Y cross-reference links in all book/*.qmd files.
// merge-chapters.js must run first — it writes book/_chapter-map.json which
// maps chapter numbers 1-8 to their merged HTML filenames.
//
// Same-chapter links:  (ch01.html#sec-1-2)  ->  (#sec-1-2)
// Cross-chapter links: (ch02.html#sec-2-3)  ->  (02-first-line.html#sec-2-3)

const fs = require('fs')
const path = require('path')

const BOOK = path.join(__dirname, 'book')
const MAP_FILE = path.join(BOOK, '_chapter-map.json')

if (!fs.existsSync(MAP_FILE)) {
  console.error('ERROR: book/_chapter-map.json not found — run merge-chapters.js first')
  process.exit(1)
}

const chapterMap = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'))
// chapterMap keys are strings ("1", "2", ...) from JSON

// Reverse map: html filename -> chapter number (for same-chapter detection)
const fileToChap = {}
for (const [chapNum, htmlFile] of Object.entries(chapterMap)) {
  fileToChap[htmlFile] = parseInt(chapNum, 10)
}

// Pattern: (chXX.html#anything-until-close-paren)
const LINK_RE = /\(ch(\d+)\.html(#[^)]*)\)/g

let totalFiles = 0
let totalFixed = 0

for (const fn of fs.readdirSync(BOOK)) {
  if (!fn.endsWith('.qmd')) continue

  const fp = path.join(BOOK, fn)
  const original = fs.readFileSync(fp, 'utf8')

  // Determine which chapter this file belongs to via reverse chapter-map lookup
  const htmlName = fn.replace(/\.qmd$/, '.html')
  const fileChap = fileToChap[htmlName] ?? null

  let fixCount = 0
  const fixed = original.replace(LINK_RE, (match, chapStr, anchor) => {
    const linkedChap = parseInt(chapStr, 10)
    const linkedFile = chapterMap[linkedChap]

    if (!linkedFile) return match // chapter not in map — leave as-is

    fixCount++
    if (linkedChap === fileChap) {
      // Same chapter — strip the filename, keep only the anchor
      return `(${anchor})`
    } else {
      // Cross-chapter — use the new merged filename
      return `(${linkedFile}${anchor})`
    }
  })

  if (fixCount > 0) {
    fs.writeFileSync(fp, fixed, 'utf8')
    console.log(`  ${fn}: fixed ${fixCount} link(s)`)
    totalFixed += fixCount
    totalFiles++
  }
}

console.log(`\nDone. Fixed ${totalFixed} cross-reference link(s) across ${totalFiles} file(s).`)
