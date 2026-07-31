// fix-titles.js
// Rewrites the YAML title at the top of each book/*.qmd file so chapter
// titles match the section-title format ("1 The Nature of Necessity"
// instead of "Chapter 1 — The Nature of Necessity"). Appendix titles
// ("Appendix A: …") are baked in by merge-chapters.js and left untouched —
// these chapters aren't under Quarto's book.appendices: key (see that
// script's APPARATUS section), so there's no auto-label to double up with.

const fs = require('fs')
const path = require('path')

const BOOK_DIR = path.join(__dirname, 'book')

// Explicit overrides for non-chapter files.
const FORCED = {
  '00-front-matter.qmd': 'Front Matter',
  '99-back-matter.qmd': 'Conclusion',
  'misc.qmd': 'Miscellaneous',
}

const files = fs.readdirSync(BOOK_DIR).filter(f => f.endsWith('.qmd'))

for (const file of files) {
  const fullPath = path.join(BOOK_DIR, file)
  let content = fs.readFileSync(fullPath, 'utf8')

  // Locate frontmatter and title line.
  const fm = content.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) { console.log(`${file}: no YAML frontmatter, skipping`); continue }

  const titleLine = fm[1].match(/^title:\s*"?([^"\n]+)"?$/m)
  if (!titleLine) { console.log(`${file}: no title field, skipping`); continue }

  const oldTitle = titleLine[1].trim()
  let newTitle = oldTitle

  if (FORCED[file]) {
    newTitle = FORCED[file]
  } else {
    // "Chapter N — Title" / "Chapter N: Title" / "Chapter N. Title" → "N Title"
    newTitle = oldTitle.replace(/^Chapter\s+(\d+)\s*[—–\-:.]\s*(.+)$/i, '$1 $2')

    // "Section N.M" with no descriptive text → use first ## heading in the body
    if (/^Section\s+\d+\.\d+$/.test(newTitle)) {
      const body = content.slice(fm[0].length)
      const h2 = body.match(/^##\s+(.+?)(?:\s*\{[^}]*\})?$/m)
      if (h2) newTitle = h2[1].trim()
    }
  }

  if (newTitle === oldTitle) {
    console.log(`${file}: unchanged ("${oldTitle}")`)
    continue
  }

  const newFmContent = fm[1].replace(titleLine[0], `title: "${newTitle}"`)
  content = content.replace(`---\n${fm[1]}\n---`, `---\n${newFmContent}\n---`)
  fs.writeFileSync(fullPath, content, 'utf8')
  console.log(`${file}: "${oldTitle}" → "${newTitle}"`)
}