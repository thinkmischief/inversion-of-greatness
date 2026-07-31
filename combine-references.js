// combine-references.js
// Merges reference shards into a single file for both content/ and book/ directories.
// Run this after pulling new content from Notion before building.
const fs = require('fs')
const path = require('path')

const stripFM = t => t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')

function combineShards(dir, shards, outPath, label) {
  const shardPaths = shards.map(f => path.join(dir, f))
  const shardsPresent = shardPaths.map(p => fs.existsSync(p))
  const allPresent = shardsPresent.every(Boolean)
  const nonePresent = shardsPresent.every(p => !p)

  if (nonePresent) {
    if (fs.existsSync(outPath)) {
      console.log(`[${label}] Already combined — nothing to do.`)
    } else {
      console.log(`[${label}] No shards found — skipping.`)
    }
    return
  }

  if (!allPresent) {
    const missing = shards.filter((_, i) => !shardsPresent[i])
    console.error(`[${label}] Partial state — missing shard(s): ${missing.join(', ')}`)
    console.error(`Either restore the missing shard(s) or delete the remaining ones plus the output file to start fresh.`)
    process.exit(1)
  }

  const bodies = shardPaths.map(p => stripFM(fs.readFileSync(p, 'utf8')).trim())
  const out = `---\ntitle: "Bibliography"\nslug: "bibliography"\nindex: 123000\nrole: apparatus\nbody-classes: references-page back-matter-page\nsearch: false\n---\n\n${bodies.join('\n\n')}\n`

  fs.writeFileSync(outPath, out, 'utf8')
  for (const p of shardPaths) fs.unlinkSync(p)

  console.log(`[${label}] Combined ${shards.length} shards into ${path.relative(__dirname, outPath)}`)
}

// book/ shards → book/bibliography.qmd
// Supports both naming conventions: bibliography-* (new) and references-* (legacy)
const bookDir = path.join(__dirname, 'book')
const biblioShards = ['bibliography-a-f.qmd', 'bibliography-g-o.qmd', 'bibliography-p-z.qmd']
const legacyShards = ['references-a-f.qmd', 'references-g-o.qmd', 'references-p-z.qmd']
const shards = legacyShards.some(f => fs.existsSync(path.join(bookDir, f))) ? legacyShards : biblioShards
combineShards(
  bookDir,
  shards,
  path.join(bookDir, 'bibliography.qmd'),
  'book'
)

// Patch _quarto.yml: replace any bibliography/references shard entries with
// a single book/bibliography.qmd entry, and remove duplicate in-plain-terms.
const quartoYmlPath = path.join(__dirname, '_quarto.yml')
let yml = fs.readFileSync(quartoYmlPath, 'utf8')
const before = yml

// Replace three-shard block (either naming) with single bibliography entry
yml = yml.replace(
  /^( +)- book\/(?:bibliography|references)-a-f\.qmd\r?\n\1- book\/(?:bibliography|references)-g-o\.qmd\r?\n\1- book\/(?:bibliography|references)-p-z\.qmd/m,
  '$1- book/bibliography.qmd'
)
// Also handle the degenerate case where a previous partial patch left only a-f
yml = yml.replace(
  /^( +)- book\/(?:bibliography|references)-a-f\.qmd$/m,
  '$1- book/bibliography.qmd'
)

// Remove duplicate book/in-plain-terms.qmd (keep only the first occurrence)
const marker = '    - book/in-plain-terms.qmd\n'
const first = yml.indexOf(marker)
if (first !== -1) {
  const second = yml.indexOf(marker, first + marker.length)
  if (second !== -1) yml = yml.slice(0, second) + yml.slice(second + marker.length)
}

// Ensure book/style-preview.qmd is present in Back Matter (after for-ai-assistants)
const previewEntry = '        - book/style-preview.qmd\n'
if (!yml.includes('book/style-preview.qmd')) {
  yml = yml.replace(
    '        - book/for-ai-assistants.qmd\n',
    '        - book/for-ai-assistants.qmd\n' + previewEntry
  )
}

if (yml !== before) {
  fs.writeFileSync(quartoYmlPath, yml, 'utf8')
  console.log('[quarto.yml] Patched: consolidated bibliography shards → book/bibliography.qmd')
} else {
  console.log('[quarto.yml] Already clean — nothing to patch.')
}
