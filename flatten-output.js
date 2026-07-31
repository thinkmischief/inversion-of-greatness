'use strict'
const fs = require('fs')
const path = require('path')

const SITE = path.join(__dirname, '_site')
const SUBDIRS = ['book', 'site']

// Replace any reference to the book/ or site/ subdirectories with just "/" —
// covers HTML attributes (href, src) and JS string literals baked into
// <script> tags. Quarto renders these three different ways depending on
// which page they're on and how deep it sits relative to the project root:
// absolute ("/book/foo.html"), root-relative ("./book/foo.html" — on pages
// AT the root, like index.html), and up-one-level-relative
// ("../book/foo.html" — on pages nested one directory down, like anything
// under book/ or site/ itself, since the navbar always computes paths as
// "back to root, then down to target" rather than optimizing for
// same-directory siblings). The original version of this regex only
// matched the absolute form, so every navbar link rendered on any page
// silently 404'd once this script deleted book/ and site/ — none of them
// used the one pattern it rewrote.
function rewrite(content) {
  return content
    .replace(/(["'])(?:\.\.\/|\.\/|\/)?(book|site)\//g, '$1/')
}

console.log('Flattening _site/ output...')

// Copy HTML files from each subdir to root
for (const sub of SUBDIRS) {
  const subPath = path.join(SITE, sub)
  if (!fs.existsSync(subPath)) continue
  for (const file of fs.readdirSync(subPath)) {
    if (!file.endsWith('.html')) continue
    const dest = path.join(SITE, file)
    // Never overwrite the root index.html (home page)
    if (file === 'index.html' && fs.existsSync(dest)) continue
    fs.copyFileSync(path.join(subPath, file), dest)
    console.log(`  copied ${sub}/${file} → ${file}`)
  }
}

// Rewrite /book/ and /site/ references in all root-level HTML files
for (const file of fs.readdirSync(SITE)) {
  if (!file.endsWith('.html')) continue
  const filePath = path.join(SITE, file)
  const original = fs.readFileSync(filePath, 'utf8')
  const rewritten = rewrite(original)
  if (rewritten !== original) {
    fs.writeFileSync(filePath, rewritten, 'utf8')
    console.log(`  rewrote links in ${file}`)
  }
}

// Rewrite search.json so search results link to flat URLs
const searchJson = path.join(SITE, 'search.json')
if (fs.existsSync(searchJson)) {
  const original = fs.readFileSync(searchJson, 'utf8')
  const rewritten = rewrite(original)
  if (rewritten !== original) {
    fs.writeFileSync(searchJson, rewritten, 'utf8')
    console.log('  rewrote links in search.json')
  }
}

// Remove the now-redundant subdirectories
for (const sub of SUBDIRS) {
  const subPath = path.join(SITE, sub)
  if (fs.existsSync(subPath)) {
    fs.rmSync(subPath, { recursive: true, force: true })
    console.log(`  removed _site/${sub}/`)
  }
}

console.log('✓ All pages now at _site/ root — no /book/ or /site/ prefix')
