'use strict'
const fs = require('fs')
const path = require('path')

const SITEMAP = path.join(__dirname, '_site', 'sitemap.xml')

console.log('Fixing sitemap.xml URLs to match flattened output...')

if (!fs.existsSync(SITEMAP)) {
  console.log('  no sitemap.xml found, skipping')
  process.exit(0)
}

const original = fs.readFileSync(SITEMAP, 'utf8')

const rewritten = original
  // /index.html -> / (root)
  .replace(/<loc>(https?:\/\/[^<]+?)\/index\.html<\/loc>/g, '<loc>$1/</loc>')
  // /book/foo.html or /site/foo.html -> /foo.html
  .replace(/<loc>(https?:\/\/[^<]+?)\/(?:book|site)\/([^<]+)<\/loc>/g, '<loc>$1/$2</loc>')

if (rewritten !== original) {
  fs.writeFileSync(SITEMAP, rewritten, 'utf8')
  console.log('  ✓ rewrote sitemap.xml')
} else {
  console.log('  sitemap.xml already flat, no changes needed')
}
