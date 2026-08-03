// link-table-of-contents.js
//
// site/table-of-contents.qmd is Notion-exported prose (export-pages.js) —
// chapter/section entries as bold text with a description, no links at
// all in Notion's own copy. A bare, unclickable "table of contents" isn't
// one, so this adds hrefs back in as a build step, run right after the
// export.
//
// Deliberately NOT a hand-maintained number → file/anchor list (that's
// exactly what the previous approach was — a static local template,
// data/table-of-contents-body.md, that silently drifted from the real
// chapter files: wrong filename after a chapter retitle, several Excursus
// entries missing outright). Every anchor here is read straight out of
// the real book/*.qmd files at build time instead, so a chapter rename or
// a renumbered section can't produce a stale link — the source of truth
// is the chapter file itself, not a second copy of its structure.

const fs = require('fs')
const path = require('path')

const BOOK_DIR = path.join(__dirname, 'book')
const TOC_PATH = path.join(__dirname, 'site', 'table-of-contents.qmd')
const QUARTO_YML_PATH = path.join(__dirname, '_quarto.yml')

if (!fs.existsSync(TOC_PATH)) {
  console.log('link-table-of-contents: no site/table-of-contents.qmd — skipping.')
  process.exit(0)
}

// Chapter number -> slug, read from _quarto.yml's own "Chapters" part
// rather than hardcoded here a second time — this list only exists once,
// in the file that actually drives the book's spine.
function readChapterSlugs () {
  const yml = fs.readFileSync(QUARTO_YML_PATH, 'utf8')
  const lines = yml.split(/\r?\n/)
  const start = lines.findIndex(l => /part:\s*"Chapters"/.test(l))
  if (start === -1) throw new Error('link-table-of-contents: could not find the "Chapters" part in _quarto.yml')
  const slugs = []
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*book\/([\w-]+)\.qmd\s*$/)
    if (m) { slugs.push(m[1]); continue }
    // First line that isn't an indented "- book/....qmd" entry ends the list.
    if (/^\s*-\s*/.test(lines[i]) || /^\s*part:/.test(lines[i])) break
  }
  return slugs
}

const chapterSlugs = readChapterSlugs() // index 0 = chapter 1, etc.

// Number token ("1.1", "3.5.5", "E.6") -> {file, anchor}, and
// normalized title -> {file, anchor} (fallback for entries with no
// leading number, e.g. "Concluding Remarks"). Scans every book/*.qmd
// heading that carries a {#anchor}.
const numberMap = new Map()
const titleMap = new Map()
const normalize = (s) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9]+/g, ' ').trim()

for (const file of fs.readdirSync(BOOK_DIR)) {
  if (!file.endsWith('.qmd')) continue
  const slug = file.replace(/\.qmd$/, '')
  const text = fs.readFileSync(path.join(BOOK_DIR, file), 'utf8')
  const headingRe = /^#{1,3}\s+(.+?)\s*\{#([\w-]+)\}\s*$/gm
  let m
  while ((m = headingRe.exec(text))) {
    const title = m[1].trim()
    const anchor = m[2]
    titleMap.set(normalize(title), { file: `${slug}.html`, anchor })
    const numMatch = title.match(/^(\d+(?:\.\d+)*|E\.\d+(?:\.\d+)*)\b/)
    if (numMatch) {
      // shortTitle strips the leading number token itself (e.g. "1.2.1
      // Possibility" -> "Possibility") so a subsection can be found by
      // the bare name the Table of Contents' own prose uses for it —
      // that prose never repeats the number, just the bolded name
      // ("**Possibility** and **Impossibility** are the primitives...").
      const shortTitle = title.slice(numMatch[0].length).replace(/^[.\s]+/, '').trim()
      numberMap.set(numMatch[1], { file: `${slug}.html`, anchor, shortTitle })
    }
  }
}

// Every subsection one or more levels under `prefix` (e.g. prefix "1.2"
// matches "1.2.1", "1.2.6", but not "1.2" itself or "1.3"), indexed by
// its own bare name — this is what turns a bold term inside a section's
// descriptive paragraph into a link to that specific subsection, scoped
// to the chapter/section it actually belongs to so a generic term used
// in two different places can't cross-link to the wrong one.
function buildSubsectionIndex(prefix) {
  const idx = new Map()
  const withDot = prefix + '.'
  for (const [num, entry] of numberMap) {
    if (num.startsWith(withDot) && entry.shortTitle) idx.set(normalize(entry.shortTitle), entry)
  }
  return idx
}

// Chapters 7-9 run every section through the same five-beat template
// (What is Disputed / Required / Predicted / Confirmed / Concluded),
// so those subsection names repeat dozens of times across the chapter
// rather than naming something specific the way "Reality Precludes" or
// "Rigid Designation" do in chapters 1-6 — linking them would scatter
// the same handful of generic phrases across the whole page instead of
// pointing to something distinctive. Excluded on request. The Excursus
// (E.*) needs no explicit exclusion — its entries are flat, no numbered
// sub-subsections beneath them for buildSubsectionIndex to find — but
// is listed anyway so this stays correct if that ever changes.
const PROSE_LINK_EXCLUDED_CHAPTERS = new Set(['7', '8', '9', 'E'])

let proseLinked = 0
// Links each **Bold Term** in a section/chapter's own summary paragraph
// to the matching subsection, scoped by that section/chapter's own
// number (see buildSubsectionIndex). Terms with no matching subsection
// (not every bold phrase in Notion's prose names a real subsection —
// some are just emphasis) are left as plain bold text, not an error.
function linkProseTerms(para, prefix) {
  if (PROSE_LINK_EXCLUDED_CHAPTERS.has(prefix.split('.')[0])) return para
  const idx = buildSubsectionIndex(prefix)
  if (idx.size === 0) return para
  // (?!\]) — a **term** already wrapped in a link from an earlier run
  // (site/table-of-contents.qmd only gets re-exported from Notion when
  // its own last_edited_time changes, so this script routinely runs
  // again against its own prior output) reads as "**term**](href)...";
  // without this guard the still-bold text inside that link matches
  // AGAIN and gets wrapped a second time, nesting a link inside a link.
  return para.replace(/\*\*([^*]+)\*\*(?!\])/g, (m, term) => {
    const hit = idx.get(normalize(term))
    if (!hit) return m
    proseLinked++
    return `[**${term}**](${hit.file}#${hit.anchor}){.toc-prose-link}`
  })
}

// The Coda now folds back into book/excursus.qmd as an unnumbered
// closing section (title "Coda: What God Could the Evidence Allow?"),
// not a numbered Excursus entry — the TOC page's own entry for it
// carries only the subtitle ("What God Could the Evidence Allow?"),
// which titleMap's exact-heading-text lookup doesn't match on its own.
// One explicit alias into titleMap itself (so both the entry-bullet and
// sub-bullet passes below pick it up via their existing titleMap
// fallback) rather than weakening the exact-match lookup for everyone
// else.
const CODA_HEADING = 'Coda: What God Could the Evidence Allow?'
if (titleMap.has(normalize(CODA_HEADING))) {
  titleMap.set(normalize('What God Could the Evidence Allow?'), titleMap.get(normalize(CODA_HEADING)))
}

// Front matter / appendices / back matter: page-level links (no
// sub-numbered content, no anchor needed), keyed on the exact bold
// text Notion's own TOC page uses for each entry. Small and stable by
// nature — these are the book's fixed chrome pages, not content that
// gets renumbered or split the way chapters do.
// Keyed by normalize()d title — Notion's own typographic (curly)
// apostrophe in "Author's Notes" doesn't match a plain ASCII one, and
// normalize() already collapses that difference for every other
// lookup in this file, so this map uses it too rather than needing an
// exact-character match.
const pageMap = {
  [normalize('Preface')]: 'front-preface.html',
  [normalize('Introduction')]: 'front-introduction.html',
  [normalize('P. Preface')]: 'front-preface.html',
  [normalize('I. Introduction')]: 'front-introduction.html',
  [normalize('Appendix A: Modal Logic Primer')]: 'modal-logic-primer.html',
  [normalize('Appendix B: Summary of the Formal Proof')]: 'formal-proof-summary.html',
  [normalize('Appendix C: Derivation Map')]: 'derivation-map.html',
  [normalize('Appendix D: Empirical Predictions')]: 'empirical-predictions.html',
  [normalize("Author's Notes")]: 'authors-notes.html',
  [normalize('Acknowledgments')]: 'acknowledgments.html',
  [normalize('Symbols')]: 'symbols.html',
  [normalize('Glossary')]: 'glossary.html',
  [normalize('Bibliography')]: 'bibliography.html',
  [normalize('Index')]: 'subject-index.html',
}

let text = fs.readFileSync(TOC_PATH, 'utf8')
let linked = 0
const misses = []

// Chapter headings: "## 1. Groundwork" -> "## [1. Groundwork](groundwork.html)",
// plus "## Conclusion"/"## Excursus" (this book's own single-page
// chapters, no sub-numbered entries). Notion's own TOC writes chapters
// at H2 and sections at H3 — the previous version of this matched H3
// for chapters, which never fired at all (confirmed live: chapter
// headings rendered as plain unlinked text), silently leaving every
// chapter heading unclickable. Also relinks each chapter's own italic
// summary paragraph's bold terms (see linkProseTerms) — most chapter
// summaries don't name a subsection by its bare title, so this is a
// no-op for them, but it's a real link on the handful that do.
text = text.replace(/^## (.+)\n\n(.+)$/gm, (full, headingText, para) => {
  if (headingText.startsWith('[')) return full // already linked by an earlier run
  const numMatch = headingText.match(/^(\d+)\.\s+(.+)$/)
  let hit = null
  if (numMatch) {
    const slug = chapterSlugs[Number(numMatch[1]) - 1]
    if (slug) hit = { file: `${slug}.html` }
  } else if (headingText === 'Conclusion') {
    hit = { file: 'conclusion.html' }
  } else if (headingText === 'Excursus') {
    hit = { file: 'excursus.html' }
  }
  if (!hit) { if (numMatch) misses.push(full.split('\n')[0]); return full }
  linked++
  const linkedPara = numMatch ? linkProseTerms(para, numMatch[1]) : para
  return `## [${headingText}](${hit.file})\n\n${linkedPara}`
})

// Section headings: "### 1.2 Modal Status" -> linked the same way as a
// bullet entry (numberMap by number, titleMap/pageMap by exact title
// for unnumbered ones like "Concluding Remarks"), plus its own
// paragraph's bold terms linked to ITS subsections (prefix = this
// section's own number, e.g. "1.2" reaches "1.2.1", "1.2.6", ...).
text = text.replace(/^### (.+)\n\n(.+)$/gm, (full, headingText, para) => {
  if (headingText.startsWith('[')) return full // already linked by an earlier run
  const numMatch = headingText.match(/^(\d+(?:\.\d+)*|E\.\d+(?:\.\d+)*)\s+(.+)$/)
  const hit = (numMatch && numberMap.get(numMatch[1]))
    || titleMap.get(normalize(headingText))
    || (pageMap[normalize(headingText)] ? { file: pageMap[normalize(headingText)], anchor: null } : null)
  if (!hit) { misses.push(full.split('\n')[0]); return full }
  linked++
  const href = hit.anchor ? `${hit.file}#${hit.anchor}` : hit.file
  const linkedPara = numMatch ? linkProseTerms(para, numMatch[1]) : para
  // The number is wrapped in its own nested span (Pandoc parses a
  // bracketed span inside a link's own bracket text fine) so
  // styles/custom.css can pull it out into the left gutter — a fixed-
  // width box with a matching negative margin, not just visual offset
  // — leaving the title itself flush with the paragraph below it. Only
  // for numbered headings; "Concluding Remarks" etc. have no number to
  // hang, so the whole title stays as ordinary link text.
  const linkText = numMatch ? `[${numMatch[1]}]{.toc-h3-num} ${numMatch[2]}` : headingText
  return `### [${linkText}](${href})\n\n${linkedPara}`
})

// Entry bullets: "- **1.1 Reality** · ..." / "- **E.6 Atonement** · ..."
// / "- **Concluding Remarks** · ..." / "- **Preface** · ..." — the
// trailing " · description" group is now OPTIONAL (`( · .+)?`), not
// required. The 2026-07-19 restructure ("Restructured this page...
// into a standard three-tier ToC... titles and numbers only, no
// descriptions") removed every description on this page outright;
// requiring that group left every single entry bullet unmatched,
// confirmed live as 10 linked (chapter headings only, a separate
// regex above) against 306 the previous version of this page reached.
text = text.replace(/^(- )\*\*([^*]+)\*\*( · .+)?$/gm, (line, prefix, title, rest) => {
  const numMatch = title.match(/^(\d+(?:\.\d+)*|E\.\d+(?:\.\d+)*)\b/)
  let hit = (numMatch && numberMap.get(numMatch[1]))
    || titleMap.get(normalize(title))
    || (pageMap[normalize(title)] ? { file: pageMap[normalize(title)], anchor: null } : null)
  // Bare chapter number ("1. Groundwork", "9. Maximum Possibility") with
  // no dotted subsection part. numberMap only holds §-level anchors read
  // out of {#anchor} headings inside each chapter file — a chapter's own
  // top-level title carries no such anchor, so it falls through
  // numberMap/titleMap/pageMap above and needs chapterSlugs instead, the
  // same lookup the old "## " chapter-heading pass above used before this
  // page was restructured into a flat bullet list (no "## " left for
  // that pass to ever match anymore). Confirmed live: every chapter
  // bullet plus "Conclusion" and "Excursus" was silently left as plain
  // unlinked bold text — the sub-bullets beneath them link fine (a
  // separate pass, further below), so only the chapter-level entries
  // themselves went dead, matching a reader's report that "the sub menu
  // items work... but the chapter headers don't."
  if (!hit && numMatch && /^\d+$/.test(numMatch[1])) {
    const slug = chapterSlugs[Number(numMatch[1]) - 1]
    if (slug) hit = { file: `${slug}.html`, anchor: null }
  }
  if (!hit && title === 'Conclusion') hit = { file: 'conclusion.html', anchor: null }
  if (!hit && title === 'Excursus') hit = { file: 'excursus.html', anchor: null }
  if (!hit) { misses.push(line); return line }
  linked++
  const href = hit.anchor ? `${hit.file}#${hit.anchor}` : hit.file
  // rest (" · description"), when present, is wrapped in a Pandoc
  // bracketed span (native to Quarto's markdown, no filter needed) so
  // styles/custom.css can size/color the description independently of
  // the title — plain text right after a link has no element of its
  // own to select otherwise. A literal space between the link's
  // closing `)` and the span's opening `[` is required — jammed
  // directly together (`)[...]`) silently failed to parse as a span at
  // all (confirmed live: rendered as plain unwrapped text, brackets
  // stripped, no surrounding element in the HTML whatsoever) — rest
  // itself still supplies its own leading space before the "·", so
  // trim() here avoids doubling it up. No rest at all (this page's
  // current shape): just the linked title, nothing appended.
  if (!rest) return `${prefix}[**${title}**](${href})`
  return `${prefix}[**${title}**](${href}) [${rest.trim()}]{.toc-entry-desc}`
})

// Indented sub-bullets: "  - **Reality Precludes** · The foreclosures...".
// The entry-bullets pass above only ever matches "^- " (anchored, no
// leading whitespace) — confirmed live, every nested sub-bullet under a
// section entry (1.1 Reality's own "Reality Precludes"/"Reality Permits"/
// "Reality Grounds", and the same one level down under every other
// section) was silently skipped by that regex entirely, left as plain
// unlinked bold text with no .toc-entry-desc styling on its own
// description either. These carry no leading number of their own
// ("Reality Precludes", not "1.1.1 Reality Precludes") — the same bare-
// name lookup linkProseTerms already does for in-prose bold terms,
// scoped to whichever section entry most recently preceded this line
// (buildSubsectionIndex(currentPrefix)), reused here rather than
// duplicating that matching logic a second time. Stateful line-by-line
// scan, not a single regex.replace(), because "which section does this
// sub-bullet belong to" depends on what came before it in the file —
// nothing a single match can see on its own.
const lines = text.split('\n')
let currentPrefix = null
let subLinked = 0
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  // Top-level section/chapter entry, linked or not yet linked —
  // "- **1.1 Reality**..." or "- [**1.1 Reality**](...)..." — updates
  // which section any indented sub-bullets below it belong to.
  const topLevelMatch = line.match(/^- \[?\*\*(\d+(?:\.\d+)*|E\.\d+(?:\.\d+)*)\b/)
  if (topLevelMatch) { currentPrefix = topLevelMatch[1]; continue }
  // Any OTHER top-level bullet ("- **Coda**", "- **Author's Notes**",
  // linked or not) also starts a fresh run of sub-bullets underneath
  // it, just with no NUMBER to scope buildSubsectionIndex by — those
  // sub-bullets fall back to titleMap/pageMap below instead (on
  // request: Coda's own child and Author's Notes' three children are
  // exactly this case, both added after this loop was first written).
  if (/^- \[?\*\*/.test(line)) { currentPrefix = null; continue }
  // A blank line or a new "##"/"###" heading ends the current section's
  // own run of sub-bullets — without this, a stray indented bullet
  // somewhere unrelated could pick up a stale prefix from many lines
  // earlier.
  if (/^\s*$/.test(line) || /^#{1,3}\s/.test(line)) { currentPrefix = null; continue }
  // ( · .+)? — optional, same reasoning as the entry-bullet regex
  // above: this page's current shape has no descriptions at all.
  const subMatch = line.match(/^(\s+- )\*\*([^*]+)\*\*(?!\])( · .+)?$/)
  if (subMatch) {
    let hit = null
    if (currentPrefix) {
      const idx = buildSubsectionIndex(currentPrefix)
      // buildSubsectionIndex keys its entries by shortTitle — the bare
      // name with its own leading number already stripped (see the
      // numberMap build above). This content's own sub-bullets carry
      // that number ("2.7.1 Null State (∅)"), not just the bare name
      // ("Null State (∅)") the older content this matcher was written
      // against used — confirmed live as 0 successful matches across
      // the entire page, every nested sub-bullet silently falling
      // through to misses instead. Stripping the same number token
      // before the lookup (display text below still keeps the full
      // "2.7.1 Null State (∅)" — only the lookup key changes) is what
      // actually reaches these entries.
      const bareTitle = subMatch[2].replace(/^(?:\d+(?:\.\d+)*|E\.\d+(?:\.\d+)*)\b[.\s]*/, '')
      hit = idx.get(normalize(bareTitle))
    }
    // No numeric context (Coda's child, Author's Notes' three
    // children) — same titleMap/pageMap fallback the entry-bullet pass
    // above uses, since these sub-bullets name real pages/anchors just
    // like a top-level entry would, they just happen to sit nested
    // under an unnumbered group label instead of "## Back Matter"
    // directly.
    if (!hit) {
      hit = titleMap.get(normalize(subMatch[2]))
        || (pageMap[normalize(subMatch[2])] ? { file: pageMap[normalize(subMatch[2])], anchor: null } : null)
    }
    if (hit) {
      const href = hit.anchor ? `${hit.file}#${hit.anchor}` : hit.file
      lines[i] = subMatch[3]
        ? `${subMatch[1]}[**${subMatch[2]}**](${href}) [${subMatch[3].trim()}]{.toc-entry-desc}`
        : `${subMatch[1]}[**${subMatch[2]}**](${href})`
      subLinked++
    } else {
      misses.push(line)
    }
  }
}
text = lines.join('\n')
linked += subLinked

// On request: flatten this page from "## chapter/group heading" +
// a separate bulleted list under each one into ONE continuous nested
// bullet list — chapter and group titles (Front Matter, 1. Groundwork,
// Back Matter, ...) become top-level bullets instead of "##" headings,
// matching the reader's own Notion page directly: "the actual formatting
// of the page... just the list, straight up list."
// Guarded on the presence of a real "## " heading: NOT idempotent
// otherwise — re-running the two indent-shift replaces below against an
// ALREADY-flattened file (no "##" headings left to convert into new
// top-level bullets) just shifts every existing level one deeper with
// nothing added at the top, collapsing two previously-distinct levels
// (e.g. "1.1" and "1.1.1") onto the same indent. Confirmed live: this
// page's own numbered sub-subsections ended up flattened onto their
// parent subsection's level after an accidental second run. A genuine
// fresh Notion pull always starts with "## " chapter headings still
// present, so this guard only ever skips a redundant re-run, never a
// legitimate first one.
if (/^## /m.test(text)) {
  // Order matters: re-indent the EXISTING bullets one level deeper BEFORE
  // turning each "##" heading into a brand-new top-level bullet — done the
  // other way around, the newly-created heading-bullets (which also start
  // with "- ") would get caught by the same re-indent pass and pushed a
  // level too deep, along with every real top-level bullet.
  text = text.replace(/^  - /gm, '    - ')
  text = text.replace(/^- /gm, '  - ')
  // Linked headings ("## [Title](href)") — matches every real chapter,
  // Conclusion, and Excursus once link-table-of-contents.js's own earlier
  // passes (above) have run.
  text = text.replace(/^## \[(.+?)\]\((.+?)\)$/gm, '- [**$1**]($2)')
  // Unlinked headings ("## Front Matter", "## Coda", "## Appendices",
  // "## Back Matter") — these are group labels, never chapters, so the
  // earlier chapter-linking pass (above) always leaves them as plain text.
  text = text.replace(/^## (.+)$/gm, '- **$1**')
}

fs.writeFileSync(TOC_PATH, text)
console.log(`link-table-of-contents: linked ${linked} entries (${subLinked} nested sub-bullets), ${proseLinked} in-prose subsection terms.`)
if (misses.length) {
  console.warn(`link-table-of-contents: ${misses.length} entries had no matching anchor/page and were left unlinked:`)
  misses.forEach(l => console.warn('  ' + l.trim()))
}
