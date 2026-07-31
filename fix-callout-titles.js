// fix-callout-titles.js
// Ensures a blank line between the bold title and the body text inside
// callout blocks (.definition, .theorem, .lemma, .corollary, .condition,
// .premise, .argument). Quarto needs the blank line to render them as
// separate <p> elements so the CSS first-child divider works correctly.
//
// Transforms:
//   ::: {.definition}
//   **Reality**
//   What anything real belongs to...
//
// Into:
//   ::: {.definition}
//   **Reality**
//
//   What anything real belongs to...

const fs   = require('fs')
const path = require('path')

const BOOK_DIR = path.join(__dirname, 'book')
const CALLOUT_RE = /^:::\s*\{\.(?:definition|theorem|lemma|corollary|condition|premise|argument)\}/

function fixCalloutTitles(text) {
  const lines  = text.split('\n')
  const result = []
  let depth = 0   // tracks ::: nesting
  let inTarget = false  // true when inside one of our callout types

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Opening :::
    if (/^:::/.test(line)) {
      if (CALLOUT_RE.test(line)) {
        inTarget = true
        depth = 1
      } else if (inTarget) {
        depth++
      }
      result.push(line)
      continue
    }

    // Closing :::
    if (line === ':::' || line === '::: ') {
      if (inTarget) {
        depth--
        if (depth === 0) inTarget = false
      }
      result.push(line)
      continue
    }

    result.push(line)

    // If we're directly inside a target callout (depth 1), on a bold title
    // line, and the next line is non-empty body text — insert a blank line.
    if (inTarget && depth === 1 && /^\*\*/.test(line)) {
      const next = lines[i + 1]
      if (next !== undefined && next.trim() !== '' && !/^:::/.test(next)) {
        result.push('')
      }
    }
  }

  return result.join('\n')
}

let totalFiles = 0
let totalFixed = 0

for (const fn of fs.readdirSync(BOOK_DIR).sort()) {
  if (!fn.endsWith('.qmd')) continue
  const fp       = path.join(BOOK_DIR, fn)
  const original = fs.readFileSync(fp, 'utf8')
  const fixed    = fixCalloutTitles(original)
  if (fixed !== original) {
    fs.writeFileSync(fp, fixed, 'utf8')
    console.log(`  fixed: ${fn}`)
    totalFiles++
    totalFixed++
  }
}

console.log(`\nDone. Updated ${totalFiles} file(s).`)
