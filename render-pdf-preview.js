#!/usr/bin/env node

// render-pdf-preview.js
// Fast PDF preview of book/style-preview.qmd alone — the design-QA page
// used to check semantic-box styling, fonts, and callouts without paying
// for a full ~28-chapter, hour-plus book PDF render (see render-pdf.js).
//
// Rendering style-preview.qmd directly (`quarto render book/style-preview.qmd
// --to pdf`) does NOT work for this: outside the book's own chapters: list,
// Quarto treats it as a standalone document and falls back to its generic
// PDF defaults (scrartcl class, lualatex) instead of this project's actual
// book styling (documentclass: book, xelatex, custom fonts, pdf-blocks.tex,
// semantic-blocks.lua). To preview the REAL styling, the page has to be
// rendered as part of the book.
//
// So instead this temporarily replaces the entire book.chapters: list with
// just [index.qmd, book/style-preview.qmd] and does a real (but now tiny)
// project-wide PDF render. index.qmd is required first (Quarto book
// projects error without a home page); its content is then dropped from the
// output for free by filters/semantic-blocks.lua's existing "Home" ->
// REMOVE chapter transform, the same mechanism that already excludes it
// from the full book PDF. Then restores the original file.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const QUARTO_YML = path.join(__dirname, '_quarto.yml')

const CHAPTERS_BLOCK = / {2}chapters:\n[\s\S]*?\n(?=format:)/

const original = fs.readFileSync(QUARTO_YML, 'utf8')

if (!CHAPTERS_BLOCK.test(original)) {
  console.error('Could not find the book chapters: block in _quarto.yml — aborting without changes.')
  process.exit(1)
}

const modified = original.replace(
  CHAPTERS_BLOCK,
  '  chapters:\n    - index.qmd\n    - book/style-preview.qmd\n\n'
)

fs.writeFileSync(QUARTO_YML, modified, 'utf8')
console.log('Patched _quarto.yml for style-preview PDF render (chapters: reduced to just this page).')

try {
  execSync('quarto render --to pdf', { cwd: __dirname, stdio: 'inherit' })
  const out = path.join(__dirname, '_site', 'The-Inversion-of-Greatness.pdf')
  const dest = path.join(__dirname, '_site', 'style-preview.pdf')
  if (fs.existsSync(out)) {
    fs.renameSync(out, dest)
    console.log(`\nStyle preview PDF: _site/style-preview.pdf`)
  }
} finally {
  fs.writeFileSync(QUARTO_YML, original, 'utf8')
  console.log('Restored _quarto.yml.')
}
