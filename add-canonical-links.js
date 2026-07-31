'use strict'
const fs = require('fs')
const path = require('path')

const SITE = path.join(__dirname, '_site')
const SITE_URL = 'https://inversionofgreatness.org'

console.log('Adding canonical <link> + og:url/og:type tags...')

for (const file of fs.readdirSync(SITE)) {
  if (!file.endsWith('.html')) continue
  const filePath = path.join(SITE, file)
  const original = fs.readFileSync(filePath, 'utf8')

  if (/<link rel="canonical"/.test(original)) continue

  const href = file === 'index.html' ? `${SITE_URL}/` : `${SITE_URL}/${file}`
  // og:url and og:type are two of the Open Graph protocol's four required
  // properties (with og:title and og:image, both already emitted by
  // Quarto's own open-graph config) — link scrapers/crawlers were missing
  // them on every page.
  const tags =
    `<link rel="canonical" href="${href}">\n` +
    `<meta property="og:url" content="${href}">\n` +
    `<meta property="og:type" content="website">\n`
  const rewritten = original.replace(/<\/head>/, `${tags}</head>`)

  if (rewritten !== original) {
    fs.writeFileSync(filePath, rewritten, 'utf8')
    console.log(`  ${file} → ${href}`)
  }
}

console.log('✓ Canonical/OG tags added')
