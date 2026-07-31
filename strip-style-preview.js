'use strict'
const fs = require('fs')
const path = require('path')

// strip-style-preview.js
// Removes the dev-only design-QA page (book/style-preview.qmd) from the
// PUBLISHED build. It has to stay a real chapters: entry in _quarto.yml
// (a Quarto book project 404s any page that isn't part of the book
// structure, confirmed live — see that file's own comment), so
// `quarto preview` keeps working locally throughout. This script runs
// once, after `quarto render`, and deletes the rendered page plus its
// entries from the search index — so the URL simply doesn't exist in
// _site/, rather than existing-but-unlinked. Must run BEFORE
// flatten-output.js: that script copies every book/*.html file to the
// site root and deletes book/ entirely, so deleting after flattening
// would mean chasing it at a different path.

const SITE = path.join(__dirname, '_site')
const PAGE = path.join(SITE, 'book', 'style-preview.html')

if (fs.existsSync(PAGE)) {
  fs.rmSync(PAGE)
  console.log('  removed _site/book/style-preview.html')
} else {
  console.log('  _site/book/style-preview.html not found (already absent)')
}

const searchJson = path.join(SITE, 'search.json')
if (fs.existsSync(searchJson)) {
  const data = JSON.parse(fs.readFileSync(searchJson, 'utf8'))
  const filtered = data.filter((entry) => !(entry.href || '').includes('style-preview'))
  if (filtered.length !== data.length) {
    fs.writeFileSync(searchJson, JSON.stringify(filtered, null, 2), 'utf8')
    console.log(`  removed ${data.length - filtered.length} search.json entries for style-preview`)
  }
}
