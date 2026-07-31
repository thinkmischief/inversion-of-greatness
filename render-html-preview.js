#!/usr/bin/env node

// render-html-preview.js
// Fast HTML preview of book/style-preview.qmd alone, same reasoning as
// render-pdf-preview.js: style-preview.qmd is deliberately NOT in the
// book's own chapters: list (it's a design-QA page, not part of the
// book), so rendering it directly (`quarto render book/style-preview.qmd
// --to html`) makes Quarto treat it as a standalone document and skip
// the project's real theme entirely — none of styles/custom.css,
// styles/themes/procyon.css, or resources/book-scripts.html get linked,
// so it's useless for actually checking box/color styling.
//
// So instead this temporarily replaces the entire book.chapters: list
// with a small representative SLICE (not the full ~30+ chapters, but
// enough real front/main/back-matter pages — with real part: groupings —
// that the left "Chapter Contents" sidebar and the Margin Notes toggle
// have something realistic to show, not just a near-empty 2-entry list)
// and does a real project-wide HTML render — a genuine book page, real
// navbar/sidebar/stylesheet, just far fewer pages than the full site.
// Then restores the original file.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const QUARTO_YML = path.join(__dirname, '_quarto.yml')
const INDEX_HTML = path.join(__dirname, '_site', 'index.html')

const CHAPTERS_BLOCK = / {2}chapters:\n[\s\S]*?\n(?=format:)/

const original = fs.readFileSync(QUARTO_YML, 'utf8')

if (!CHAPTERS_BLOCK.test(original)) {
  console.error('Could not find the book chapters: block in _quarto.yml — aborting without changes.')
  process.exit(1)
}

const PREVIEW_CHAPTERS = `  chapters:
    - index.qmd
    - part: "Front Matter"
      chapters:
        - book/front-preface.qmd
        - book/front-introduction.qmd
    - part: "Chapters"
      chapters:
        - book/groundwork.qmd
        - book/the-argument.qmd
        - book/nature-alone.qmd
        - book/conclusion.qmd
    - part: "Back Matter"
      chapters:
        - book/glossary.qmd
        - book/bibliography.qmd
        - book/subject-index.qmd
    - book/style-preview.qmd

`

const modified = original.replace(CHAPTERS_BLOCK, PREVIEW_CHAPTERS)

// index.qmd is required first (same reason as render-pdf-preview.js), and
// unlike the PDF (one merged document, where a Lua filter drops index.qmd's
// content before final output), HTML renders each chapter to its own real
// file — so this render would overwrite the site's actual _site/index.html
// with a stripped 2-chapter version. Back it up and restore it after.
const indexBackup = fs.existsSync(INDEX_HTML) ? fs.readFileSync(INDEX_HTML) : null

fs.writeFileSync(QUARTO_YML, modified, 'utf8')
console.log('Patched _quarto.yml for style-preview HTML render (chapters: reduced to just this page).')

try {
  // --no-clean: a normal project render wipes the entire output-dir first —
  // fine for a full rebuild, catastrophic here, since _site holds the real
  // site and this render only re-produces 2 of its ~30+ pages.
  execSync('quarto render --to html --no-clean', { cwd: __dirname, stdio: 'inherit' })
  execSync('node flatten-output.js', { cwd: __dirname, stdio: 'inherit' })
  console.log('\nStyle preview HTML: _site/style-preview.html')
} finally {
  fs.writeFileSync(QUARTO_YML, original, 'utf8')
  if (indexBackup) fs.writeFileSync(INDEX_HTML, indexBackup)
  console.log('Restored _quarto.yml' + (indexBackup ? ' and _site/index.html' : '') + '.')
}
