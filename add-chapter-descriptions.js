'use strict'
const fs = require('fs')
const path = require('path')

const SITE = path.join(__dirname, '_site')

// Drafted 2026-07-18 (Analytic Pal), per the SEO Plan spec — 140-155 chars
// each, quoting the chapter's central claim, checked against each Chapter
// Profile's Role field. Source: IOG | Dashboard -> To-Do -> "Write a meta
// description for each chapter". Kept here (not in Notion/qmd frontmatter)
// because export-pages.js rewrites book/*.qmd -- including all front
// matter -- from Notion on every rebuild, which would silently discard a
// description: field added there (the same class of bug rebuild.js's own
// comments describe for the old restore-table-of-contents.js).
const DESCRIPTIONS = {
  'groundwork.html': "Before philosophy can argue for or against God's existence, its basic tools—reality, change, time, space, and substance—need exact definitions first.",
  'the-argument.html': "The book's formal core: a strict five-premise proof that time, space, and substance—Nature itself—are metaphysically necessary, not contingent.",
  'convergence.html': "Ten independent philosophical routes—modal, temporal, causal, semantic—all converge on the same conclusion, so no single one is its weak link.",
  'metaphysical-rivals.html': "Modal skeptics, four-dimensionalists, and philosophers of physics each try to escape the argument's structure—and each ends up presupposing it instead.",
  'rival-ultimates.html': "Classical theism and its non-classical rivals each propose something more fundamental than structure—and each, examined closely, fails to unseat it.",
  'relocating-greatness.html': "Omniscience, omnipotence, and perfect goodness: the attributes the tradition gave to God turn out, one by one, to belong to Nature itself instead.",
  'nature-alone.html': "Physics, cosmology, and biology are shown to converge, by their own methods, on the same conclusion: Nature alone suffices, with nothing external needed.",
  'expanding-the-field.html': "Drive, feeling, meaning, mortality: what it feels like to be alive turns out to be the felt side of a structure the previous chapters already proved.",
  'maximum-possibility.html': "From metaphysics to politics: rights, legitimacy, and non-domination turn out to be structural conditions any sustainable society must satisfy.",
  'excursus.html': "The Fall, original sin, and the soul-making theodicy each depend on an account of will, knowledge, and morality this book has already disproved.",
}

console.log('Adding per-chapter meta descriptions...')

for (const [file, description] of Object.entries(DESCRIPTIONS)) {
  const filePath = path.join(SITE, file)
  if (!fs.existsSync(filePath)) {
    console.log(`  ! ${file} not found, skipping`)
    continue
  }
  let content = fs.readFileSync(filePath, 'utf8')
  const original = content

  content = content
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${description}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${description}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${description}$2`)

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8')
    console.log(`  ${file}`)
  }
}

console.log('✓ Chapter descriptions added')
