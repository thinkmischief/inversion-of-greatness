// add-section-anchors.js
// 1) Add {#sec-N-M} anchors to numbered section headings in book/*.qmd
// 2) Convert §N.M references in prose into markdown links to those anchors

const fs = require('fs')
const path = require('path')

const BOOK = path.join(__dirname, 'book')
const files = fs.readdirSync(BOOK).filter(f => f.endsWith('.qmd'))

// Chapter files are named by slug (groundwork.html, the-argument.html, …),
// not by position (ch01.html) — merge-chapters.js writes the authoritative
// chapter-number → filename mapping to _chapter-map.json on every run
// specifically so nothing else has to hardcode it. This used to hardcode
// "ch0N.html" for chapters 1-8 (and silently drop chapter 9 entirely) — no
// file by that name has ever existed, so every §N.M cross-reference in the
// book linked to a 404.
const CHAPTER_MAP_PATH = path.join(BOOK, '_chapter-map.json')
const chapterMap = JSON.parse(fs.readFileSync(CHAPTER_MAP_PATH, 'utf8'))

function chapterFile(n) {
  return chapterMap[String(parseInt(n, 10))] || null
}

let totalAnchors = 0
let totalLinks = 0

// PASS 1: add anchors to ## / ### / #### N(.M(.K)) headings
for (const file of files) {
  const fp = path.join(BOOK, file)
  let text = fs.readFileSync(fp, 'utf8')
  let added = 0

  text = text.replace(
    /^(#{2,6})\s+(\d+(?:\.\d+){0,2})(\s+[^\n{]*?)(\s*\{[^}]*\})?$/gm,
    (m, hashes, num, rest, attrs) => {
      if (attrs && attrs.includes('#sec-')) return m
      const id = `sec-${num.replace(/\./g, '-')}`
      added++
      if (attrs) {
        return `${hashes} ${num}${rest}${attrs.replace(/\}$/, ` #${id}}`)}`
      }
      return `${hashes} ${num}${rest} {#${id}}`
    },
  )

  if (added > 0) {
    fs.writeFileSync(fp, text, 'utf8')
    totalAnchors += added
    console.log(`${file}: +${added} anchor(s)`)
  }
}

console.log(`\nTotal anchors added: ${totalAnchors}\n`)

// PASS 2: convert §N.M (or §N.M.K) in prose to markdown links
for (const file of files) {
  const fp = path.join(BOOK, file)
  let text = fs.readFileSync(fp, 'utf8')
  let converted = 0

  // Protect existing links, code spans, code blocks
  const stash = []
  const protect = (re) => {
    text = text.replace(re, (m) => {
      stash.push(m)
      return `\u0000${stash.length - 1}\u0000`
    })
  }
  protect(/```[\s\S]*?```/g)
  protect(/`[^`\n]+`/g)
  protect(/\[[^\]]*\]\([^)\n]*\)/g)

  // Match §N.M or §N.M.K (require at least one dot to avoid false positives
  // like "Appendix C §3" where §3 means an appendix-internal section).
  text = text.replace(/§\s?(\d+)\.(\d+)(?:\.(\d+))?/g, (m, ch, sec, sub) => {
    const target = chapterFile(ch)
    if (!target) return m
    const num = sub ? `${ch}.${sec}.${sub}` : `${ch}.${sec}`
    const anchor = `sec-${num.replace(/\./g, '-')}`
    converted++
    return `[§${num}](${target}#${anchor})`
  })

  // Restore protected content
  text = text.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[parseInt(i, 10)])

  if (converted > 0) {
    fs.writeFileSync(fp, text, 'utf8')
    totalLinks += converted
    console.log(`${file}: +${converted} link(s)`)
  }
}

console.log(`\nTotal §N.M links converted: ${totalLinks}`)
console.log('Done.')