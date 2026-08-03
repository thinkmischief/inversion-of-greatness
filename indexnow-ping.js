'use strict'
const fs = require('fs')
const path = require('path')
const https = require('https')

// Key file lives at project root (passthrough via _quarto.yml's project:
// resources:, same mechanism as robots.txt) so it's reachable at
// https://<host>/<key>.txt for IndexNow's key-location check — the file's
// own name IS the key, per protocol.
const KEY = 'b0f3c3815eca402ebcd72dd2f8dcbbec'
const HOST = 'inversionofgreatness.org'
const SITEMAP = path.join(__dirname, '_site', 'sitemap.xml')

// Runs as the last step of rebuild.js, itself Netlify's build command
// (netlify.toml), so this fires on every real production deploy — the
// closest thing to "instant" Bing/Yandex/Seznam crawling gets (Google
// doesn't support IndexNow; Search Console's own Request Indexing is
// the equivalent lever there). Never fails the build on a network
// hiccup: this is a best-effort notification, not a build requirement.
if (!fs.existsSync(SITEMAP)) {
  console.log('IndexNow: no sitemap.xml found, skipping')
  process.exit(0)
}

const urls = [...fs.readFileSync(SITEMAP, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])

if (urls.length === 0) {
  console.log('IndexNow: sitemap has no URLs, skipping')
  process.exit(0)
}

const payload = JSON.stringify({
  host: HOST,
  key: KEY,
  keyLocation: `https://${HOST}/${KEY}.txt`,
  urlList: urls,
})

const req = https.request(
  'https://api.indexnow.org/indexnow',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 10000,
  },
  (res) => {
    console.log(`IndexNow: submitted ${urls.length} URLs, response ${res.statusCode}`)
    res.resume()
  }
)
req.on('timeout', () => req.destroy(new Error('timed out')))
req.on('error', (err) => {
  console.warn('IndexNow: request failed (non-fatal):', err.message)
})
req.write(payload)
req.end()
