// fix-footnotes.js
// Converts Notion-style footnote blocks in content/*.qmd to Pandoc syntax,
// using section-slug-prefixed keys so notes from different sections can't
// collide as duplicate [^1] when merge-chapters.js stitches a chapter together.
const fs   = require('fs')
const path = require('path')

const CONTENT = path.join(__dirname, 'content')

function convertFootnotes(md, slug) {
  const notesIdx = md.search(/\n(?:---\s*\n)?\*\*Notes\*\*\s*\n/)
  if (notesIdx === -1) return md
  const before = md.slice(0, notesIdx)
  const after  = md.slice(notesIdx).replace(/^\n(?:---\s*\n)?\*\*Notes\*\*\s*\n/, '')
  const refs = []
  const re   = /\*\*\[(\d+)\]\*\*\s*([\s\S]*?)(?=\n\s*\*\*\[\d+\]\*\*|\s*$)/g
  let m
  while ((m = re.exec(after)) !== null) {
    refs.push({ num: m[1], body: m[2].trim().replace(/\n+/g, ' ') })
  }
  if (!refs.length) return md
  // Chapter-unique key derived from the section slug (= the filename).
  const key = num => `${slug}-${num}`
  let body = before
  for (const { num } of refs) {
    body = body.replace(new RegExp(`\\[${num}\\]`, 'g'), `[^${key(num)}]`)
  }
  const defs = refs.map(({ num, body }) => `[^${key(num)}]: ${body}`).join('\n\n')
  return body.trimEnd() + '\n\n' + defs + '\n'
}

const files = fs.readdirSync(CONTENT).filter(f => f.endsWith('.qmd'))
let fixed = 0
for (const file of files) {
  const fp        = path.join(CONTENT, file)
  const slug      = path.basename(file, '.qmd')
  const original  = fs.readFileSync(fp, 'utf8')
  const converted = convertFootnotes(original, slug)
  if (converted !== original) {
    fs.writeFileSync(fp, converted, 'utf8')
    console.log(`Fixed: ${file}`)
    fixed++
  }
}
console.log(`\n${fixed} file(s) updated. Re-run merge-chapters.js to propagate to book/.`)