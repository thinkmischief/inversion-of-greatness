'use strict'
const fs = require('fs')
const path = require('path')

const SITE = path.join(__dirname, '_site')
const SITE_URL = 'https://inversionofgreatness.org'
const AUTHOR = 'Procyon'
const BOOK_NAME = 'The Inversion of Greatness'
const BOOK_URL = `${SITE_URL}/`

// Matches _quarto.yml's own book: chapters: order (Front Matter, then
// Chapters, then Conclusion/Excursus) — the narrative spine only, not
// Appendices/References/Resources, which aren't "chapters" in the
// schema.org sense. Filenames match flatten-output.js's own output
// (book/*.qmd -> *.html at site root).
const CHAPTERS = [
  { file: 'front-preface.html', name: 'Preface' },
  { file: 'front-introduction.html', name: 'Introduction' },
  { file: 'groundwork.html', name: '1. Groundwork' },
  { file: 'the-argument.html', name: '2. The Argument' },
  { file: 'convergence.html', name: '3. Convergence' },
  { file: 'metaphysical-rivals.html', name: '4. Metaphysical Rivals' },
  { file: 'rival-ultimates.html', name: '5. Rival Ultimates' },
  { file: 'relocating-greatness.html', name: '6. Relocating Greatness' },
  { file: 'nature-alone.html', name: '7. Sola Natura' },
  { file: 'expanding-the-field.html', name: '8. Expanding the Field' },
  { file: 'maximum-possibility.html', name: '9. Maximum Possibility' },
  { file: 'conclusion.html', name: 'Conclusion' },
  { file: 'excursus.html', name: 'Excursus' },
]

console.log('Adding schema.org Book/Chapter structured data...')

// Book-level JSON-LD lives on the home page only, with hasPart listing
// every chapter in reading order — the one canonical place a crawler
// (or an AI agent doing structured extraction rather than reading
// llms.txt) can discover "this is a Book, here is its full chapter
// list, in order" in one machine-readable block.
const bookLd = {
  '@context': 'https://schema.org',
  '@type': 'Book',
  name: BOOK_NAME,
  url: BOOK_URL,
  author: { '@type': 'Person', name: AUTHOR },
  inLanguage: 'en',
  hasPart: CHAPTERS.map((c, i) => ({
    '@type': 'Chapter',
    position: i + 1,
    name: c.name,
    url: `${SITE_URL}/${c.file}`,
  })),
}

const indexPath = path.join(SITE, 'index.html')
if (fs.existsSync(indexPath)) {
  let content = fs.readFileSync(indexPath, 'utf8')
  if (!/"@type":\s*"Book"/.test(content)) {
    const script = `<script type="application/ld+json">${JSON.stringify(bookLd)}</script>\n`
    content = content.replace(/<\/head>/, `${script}</head>`)
    fs.writeFileSync(indexPath, content, 'utf8')
    console.log('  index.html: Book + hasPart (13 chapters)')
  }
}

// Per-chapter JSON-LD: a minimal Chapter record pointing back at the
// Book via isPartOf, the mirror image of the Book's own hasPart above
// — either direction is enough for a crawler to walk the relationship,
// but both together cost nothing and remove any ambiguity about which
// end is authoritative.
for (const [i, c] of CHAPTERS.entries()) {
  const filePath = path.join(SITE, c.file)
  if (!fs.existsSync(filePath)) {
    console.log(`  ! ${c.file} not found, skipping`)
    continue
  }
  let content = fs.readFileSync(filePath, 'utf8')
  const original = content

  if (!/"@type":\s*"Chapter"/.test(content)) {
    const chapterLd = {
      '@context': 'https://schema.org',
      '@type': 'Chapter',
      position: i + 1,
      name: c.name,
      url: `${SITE_URL}/${c.file}`,
      isPartOf: { '@type': 'Book', name: BOOK_NAME, url: BOOK_URL },
      author: { '@type': 'Person', name: AUTHOR },
    }
    const script = `<script type="application/ld+json">${JSON.stringify(chapterLd)}</script>\n`
    content = content.replace(/<\/head>/, `${script}</head>`)
  }

  // og:type: "book" for the actual narrative chapters specifically —
  // add-canonical-links.js sets a blanket "website" for every page,
  // which is right for Appendices/References/Resources but undersells
  // what these pages actually are.
  content = content.replace(
    /<meta property="og:type" content="website">/,
    '<meta property="og:type" content="book">'
  )

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8')
    console.log(`  ${c.file}: Chapter + og:type=book`)
  }
}

console.log('✓ Structured data added')
