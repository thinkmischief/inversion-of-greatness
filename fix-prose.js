// fix-prose.js
// Post-merge cleanup on book/*.qmd:
//   1. Normalize nested italic-around-link patterns like *[*X*](url)* -> [X](url)
//   2. Insert blank lines between list items and following paragraphs

const fs = require('fs')
const path = require('path')

const BOOK = path.join(__dirname, 'book')
const files = fs.readdirSync(BOOK).filter(f => f.endsWith('.qmd'))

let totalSpacing = 0
let totalItalics = 0

for (const file of files) {
  const fp = path.join(BOOK, file)
  let text = fs.readFileSync(fp, 'utf8')
  let fileItalics = 0

  text = text.replace(/\*\[\*([^*\]\n]+)\*\]\(([^)\n]+)\)\*/g, (m, txt, url) => {
    fileItalics++
    return `[${txt}](${url})`
  })

  const lines = text.split('\n')
  const out = []
  let spacingFixed = 0

  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const cur = lines[i]
    const next = lines[i + 1] || ''

    const isListItem = /^(\d+\.|\*|-)\s+/.test(cur)
    if (!isListItem) continue
    if (next.trim() === '') continue
    if (/^(\d+\.|\*|-)\s+/.test(next)) continue
    if (/^#+\s/.test(next)) continue
    if (/^   /.test(next)) continue
    if (next.startsWith(':::')) continue
    if (/^---\s*$/.test(next)) continue

    out.push('')
    spacingFixed++
  }

  const final = out.join('\n')
  if (final !== fs.readFileSync(fp, 'utf8')) {
    fs.writeFileSync(fp, final, 'utf8')
    totalSpacing += spacingFixed
    totalItalics += fileItalics
    if (spacingFixed > 0 || fileItalics > 0) {
      console.log(`${file}: +${spacingFixed} blank line(s), -${fileItalics} stray asterisk pair(s)`)
    }
  }
}

console.log(`\nTotal blank lines inserted: ${totalSpacing}`)
console.log(`Total nested italic-links cleaned: ${totalItalics}`)