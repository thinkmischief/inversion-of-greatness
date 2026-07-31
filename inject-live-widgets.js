// inject-live-widgets.js
// Notion can't run live third-party embeds (iframes, JS widgets), so pages
// that need one author a collapsed <details> block — convention: a summary
// starting "🔧 Web build only" — whose visible text is a note for Notion
// readers, with the actual embed markup sitting inside a fenced ```html
// code sample underneath (so it at least displays as legible text there,
// instead of nothing). Quarto/Pandoc treats a plain ```html fence as a
// syntax-highlighted CODE SAMPLE, not as markup to run — left alone, this
// note-to-self renders on the live site exactly as inert text, which is
// the opposite of what it says should happen. This script finds every such
// block and replaces it with a Pandoc raw-HTML block (```{=html} ... ```),
// which Quarto passes through verbatim as real page content.
const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const DIRS = ['content', 'site'].map(d => path.join(ROOT, d))

// (?:(?!<details>)[\s\S])*? in place of a plain [\s\S]*? on both sides of
// the ```html fence — without it, a placeholder with NO fence of its own
// (e.g. the contact form's, which this script has nothing to inject and
// is meant to just skip) lets the lazy match run straight past its own
// </details> and into the NEXT "Web build only" block, swallowing
// everything between the two (including real prose in between, like a
// whole "## Support the work" section) and injecting the wrong block's
// code into the first block's spot. Confirmed live: exactly this
// corruption, once the contact-form placeholder (no fence) sat right
// before the Ko-fi placeholder (has a fence) in the same file. The
// lookahead keeps each match scoped to its own <details>...</details>.
const BLOCK_RE = /<details>\s*<summary>🔧 Web build only[^<]*<\/summary>(?:(?!<details>)[\s\S])*?```html\n([\s\S]*?)\n```(?:(?!<details>)[\s\S])*?<\/details>\n?/g

let totalFiles = 0
let totalWidgets = 0

for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.qmd')) continue
    const fp = path.join(dir, f)
    const text = fs.readFileSync(fp, 'utf8')
    let count = 0
    const next = text.replace(BLOCK_RE, (m, html) => {
      count++
      return '```{=html}\n' + html.trim() + '\n```\n'
    })
    if (count > 0) {
      fs.writeFileSync(fp, next, 'utf8')
      totalFiles++
      totalWidgets += count
      console.log(`${path.relative(ROOT, fp)}: +${count} live widget(s) activated`)
    }
  }
}

console.log(`\nDone. ${totalWidgets} widget(s) activated across ${totalFiles} file(s).`)
