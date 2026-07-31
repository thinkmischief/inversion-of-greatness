// merge-chapters.js
// Scans all .qmd under content/, deduplicates by index (most-recent mtime wins),
// derives role, and routes to book/ output:
//
//   Front spine (index <10000)              → book/front-{slug}.qmd, one per page
//   Chapters 1-CHAPTER_COUNT (10000-CONCLUSION_START-1) → book/{NN}-{slug}.qmd, merged by chapter
//   Conclusion  (CONCLUSION_START-EXCURSUS_START-1)     → book/conclusion.qmd
//   Excursus    (EXCURSUS_START-APPARATUS_START-1)      → book/excursus.qmd  [terminal spine, demarcated]
//   Apparatus   (>=APPARATUS_START)         → book/{slug}.qmd
//   Chrome (no index)                       → ignored (lives in site/)
//
// With --write-quarto: rewrites chapters: in _quarto.yml using part: entries
// for the main chapters, a demarcated part: for the Excursus, and a part: for
// the appendices. Appendices A-D and the subject index are placed in
// chapters: rather than Quarto's book.appendices: key — see the APPARATUS
// section below for why.
const fs   = require('fs')
const path = require('path')

const ROOT     = __dirname
const CONTENT  = path.join(ROOT, 'content')
const BOOK     = path.join(ROOT, 'book')
const FRAGMENT = path.join(ROOT, '_quarto-book-fragment.yml')
const QUARTO   = path.join(ROOT, '_quarto.yml')
const TIMESTAMPS_PATH = path.join(ROOT, 'data', 'export-timestamps.json')
const WRITE_QUARTO = process.argv.includes('--write-quarto')

// Index-range boundaries. Indices are assigned in Notion as a 5-digit
// {chap}{sec:2}{sub:2} number (e.g. 50203 = chapter 5, section 2,
// subsection 3). Each chapter gets one clean 10000-block (chapter N spans
// N0000-N9999); conclusion/excursus/apparatus all live in the block right
// after the last chapter, so they're DERIVED from CHAPTER_COUNT instead of
// being three more magic numbers that have to be kept in sync by hand —
// that desync (bumping CHAPTER_COUNT without also moving these) is exactly
// what broke the book the last time a chapter was inserted.
//
// To add a chapter beyond CHAPTER_COUNT: every chapter from the insertion
// point onward AND every apparatus index (acknowledgments, appendices A-D,
// author's notes, glossary, references, the subject index) must move to
// their new block in Notion FIRST. Only once that's actually done does
// bumping CHAPTER_COUNT here correctly track them — bumping it in
// anticipation, before the content has moved, mis-routes whatever is
// currently sitting in the newly-annexed block (this also broke the book
// once already).
const CHAPTER_COUNT     = 9
// These three match the actual index values in Notion — they can't be
// derived from CHAPTER_COUNT alone because the user's indexing scheme
// leaves a full 10000-block gap between chapters, conclusion, excursus,
// and apparatus rather than packing them directly after chapter 9.
const CONCLUSION_START  = 100000  // conclusion.qmd lives here
const EXCURSUS_START    = 110000  // excursus.qmd and E.x entries live here
const APPARATUS_START   = 120000  // appendices, back matter live here
const APPARATUS_CHAP = Math.floor(APPARATUS_START / 10000)

// body-classes injected into specific back-matter pages so CSS can target them
// back-matter-page (in addition to each page's own existing class) scopes
// the compact chrome-page title treatment (small title + dotted rule,
// styles/custom.css) shared by every true back-matter reference page. Not
// added to derivation-map — that page reuses glossary-page purely for its
// item-list CSS but is a numbered appendix, not back matter, and keeps the
// normal chapter-drop title unless asked otherwise.
// 'bibliography' is listed here for documentation only — this map is never
// actually consulted for it (the write loop below explicitly excludes
// bibliography.qmd; combine-references.js is its real writer, and carries
// the matching body-classes value itself).
const BODY_CLASSES = {
  'bibliography':   'references-page back-matter-page',
  'glossary':       'glossary-page back-matter-page',
  'derivation-map': 'glossary-page',
  'subject-index':  'subject-index-page back-matter-page',
  'index':          'subject-index-page back-matter-page',
  'symbols':        'symbols-page back-matter-page',
  // _quarto.yml's own next/prev-chapter-nav script reads this class to
  // give the Introduction's forward link its own plain "Groundwork"
  // text instead of the generic "Continue reading: <title>" every other
  // page gets — it was never wired up here (the front-matter writer
  // below didn't support body-classes at all until this same fix), so
  // that branch of the script silently never fired and every rebuild
  // regenerated book/front-introduction.qmd without it.
  'introduction':   'introduction-page',
}

// Back-matter "landing" pages whose related notes should nest under them in
// the sidebar (as part:/chapters: groups) instead of appearing as flat
// siblings. Keyed by the parent's slug; values are ordered child slugs.
// Parent and children still render as separate pages — this only changes
// how buildQuartoBlock() groups them in _quarto.yml. (Currently unused: the
// composition/peer-review/publication notes that motivated this are now
// authored as ## sections of one content/authors-notes.qmd page instead of
// three separate pages, so the generic single-bucket path below already
// produces one merged book/09-10-authors-notes.qmd with no nesting needed.)
const PART_CHILDREN = {}

// Static "Resources" group pinned near the top of chapters: (right after
// index.qmd, whichever site/*.qmd chrome page that currently resolves to —
// see the ROOT index.qmd step below, which finds it by notion-id rather
// than a hardcoded filename). These pages live in site/ as hand-maintained
// chrome that merge-chapters.js never scans, so the group is hardcoded here
// rather than derived from content/. The part is a plain string title (no
// page of its own), which is why the no-href sidebar-hide CSS/JS rule
// (styles/custom.css, and its include-after-body twin in _quarto.yml) hides
// it without needing its own href selector. Named to match the navbar's
// "Resources" dropdown, which surfaces this same group (plus Copyright) —
// see _quarto.yml's navbar: for the navbar side of this. Adding a new
// site/*.qmd page here does NOT automatically add it to the navbar or
// hide it from the left sidebar — both of those still need their own
// manual edit in _quarto.yml.
const HOME_GROUP = {
  part: '"Resources"',
  chapters: [
    'site/contact.qmd', 'site/how-to-cite.qmd', 'site/changelog.qmd', 'site/license.qmd',
  ],
}

// For AI Assistants: hand-maintained chrome living in site/, same as the
// HOME_GROUP pages above — moved there when the author relocated its
// Notion page from the Book database into the Site database. Not part of
// HOME_GROUP because it isn't linked from any navbar menu (it's for AI
// crawlers, not human navigation); it's a flat, hidden chapter instead —
// hidden from the sidebar via the JS rule in _quarto.yml, same mechanism
// as everything else that's built but not meant to be clicked into from
// the UI.
const FOR_AI_ASSISTANTS = 'site/for-ai-assistants.qmd'

// Reading Guide: hand-maintained chrome living in site/, same category as
// FOR_AI_ASSISTANTS above but linked from the navbar (unlike that page) —
// so unlike HOME_GROUP's own members it isn't hidden from the sidebar via
// the :has()/JS rule that targets the "Resources" part specifically, it
// gets its OWN sidebar-hide selector instead (styles/custom.css), matching
// how authors-notes/in-plain-terms (flat, navbar-linked, HIDDEN_BACK_SLUGS
// below) are each individually hidden rather than hidden as a group.
const READING_GUIDE = 'site/reading-guide.qmd'

// Reformat "**term.** description" → "**term** — description" so derivation-map
// entries visually match the glossary's item pattern.
function applyGlossaryItemFormat(text) {
  return text.replace(/\*\*([^*]+)\.\*\* /g, '**$1** — ')
}

// Fallback only — used when a chapter's level-1 partRoot file is missing,
// so its own Notion-authored title isn't available. Keep in sync with the
// real titles when chapters get renamed/renumbered, but it rarely fires.
const CHAPTER_TITLES = {
  1: '1 Groundwork', 2: '2 The Argument', 3: '3 The Convergence',
  4: '4 Rivals and Replies', 5: '5 Theistic Rivals', 6: '6 The Inversion',
  7: '7 Nature Alone', 8: '8 Expanding the Field', 9: '9 Maximum Possibility',
}

if (!fs.existsSync(BOOK)) fs.mkdirSync(BOOK)
// Preserve notes.qmd — it's generated by collect-notes.js (which runs after
// this script), so deleting it here would break the chapters: list check
// below. style-preview.qmd is preserved for a different reason: it's a
// hand-authored, non-Notion-sourced design-QA page (no script regenerates
// it), so it was getting silently wiped by this same cleanup sweep with
// nothing to write it back — confirmed live, the first `node rebuild.js`
// after it was added deleted it outright and it just stayed gone.
const PRESERVE_FILES = new Set(['notes.qmd', 'style-preview.qmd'])
for (const f of fs.readdirSync(BOOK)) {
  if (PRESERVE_FILES.has(f)) continue
  if (f.endsWith('.qmd') || f.endsWith('.html')) fs.unlinkSync(path.join(BOOK, f))
}

// Raw LaTeX blocks that constrain PDF TOC depth within specific chapters.
// In the book class: ## → \subsection (depth 2), ### → \subsubsection (depth 3).
// Nature Alone, Expanding the Field, and Maximum Possibility (the last
// three main chapters — currently 7-9) and the Index should show only
// depth-1 entries only (no ###-level entries) for long empirical chapters.
// depth-0 for appendices (chapter title only — no sub-entries).
const PDF_TOC_DEPTH_1   = "```{=latex}\n\\addtocontents{toc}{\\protect\\setcounter{tocdepth}{1}}\n```"
const PDF_TOC_DEPTH_0   = "```{=latex}\n\\addtocontents{toc}{\\protect\\setcounter{tocdepth}{0}}\n```"
const PDF_TOC_DEPTH_RST = "```{=latex}\n\\addtocontents{toc}{\\protect\\setcounter{tocdepth}{3}}\n```"

function wrapTocDepth(content) {
  return PDF_TOC_DEPTH_1 + '\n\n' + content + '\n\n' + PDF_TOC_DEPTH_RST
}

function wrapTocDepthAppendix(content) {
  return PDF_TOC_DEPTH_0 + '\n\n' + content + '\n\n' + PDF_TOC_DEPTH_RST
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function getYaml(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return {}
  const out = {}
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    let val = m[2].trim()
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    else if (/^-?\d+$/.test(val)) val = parseInt(val, 10)
    out[m[1]] = val
  }
  return out
}

function getBody(text) { return text.replace(/^---\n[\s\S]*?\n---\n?/, '') }

// nav-section/nav-order come through content/*.qmd frontmatter as raw,
// already-YAML-formatted strings (getYaml doesn't parse array literals —
// it just captures the line's value verbatim), so forwarding them into a
// book/*.qmd yaml block is a straight re-emit, no reparsing needed.
function navFmLines(meta) {
  let out = ''
  if (meta?.['nav-section'] != null) out += `nav-section: ${meta['nav-section']}\n`
  if (meta?.['nav-order'] != null) out += `nav-order: ${meta['nav-order']}\n`
  return out
}

// Preface/Introduction/Conclusion/Excursus carry a leading letter prefix
// ("P.", "I.", "C.", "E.") directly in their own title metadata (Notion's
// own Title property, entered that way so the numbered-chapters-style
// sidebar entry — resources/sidebar-chapter-numbers.js — reads consistently
// against "1. Groundwork" etc.). That's also the ONLY metadata field Quarto
// has to build the page's own <title> tag from, so the prefix was leaking
// into the browser tab too ("I. Introduction – The Inversion of
// Greatness") — on request: "it should just say introduction up there."
// The on-page H1 already strips this exact same prefix client-side
// (resources/book-scripts.html's own IIFE, matched on the identical
// [A-Za-z]. pattern, digits deliberately excluded since the 9 numbered
// chapters keep theirs) — this just extends the same rule to the
// server-rendered <title> tag via Quarto's pagetitle: field, which
// overrides ONLY the HTML <title>, leaving the sidebar's own copy of the
// full "I. Introduction" text (and the on-page heading, before its own JS
// strips it) untouched.
function bareTitle(title) {
  const m = /^([A-Za-z]\.)(\s+)(.+)$/.exec(title || '')
  return m ? m[3] : title
}

function normalizeDivs(text) {
  // Ensure blank line before ::: fences so Pandoc parses them as block-level
  // elements rather than inline Str nodes (which trigger Quarto warnings).
  // Also ensure blank line before numbered list items that directly follow a
  // non-blank line (e.g. a bold title inside a .premise div), otherwise Pandoc
  // treats the 1. markers as inline text continuation of the paragraph.
  return text
    .replace(/([^\n])\n(:{3,})/gm, '$1\n\n$2')
    .replace(/([^\n])\n(\d+\.\s)/gm, '$1\n\n$2')
}

function shiftHeadings(body, shift) {
  return body.replace(/^(#{1,6})(\s)/gm, (m, h, s) => '#'.repeat(Math.min(h.length + shift, 6)) + s)
}

function stripFirstH1(body) { return body.replace(/^#\s+[^\n]*\n+/, '') }

// Footnote labels (e.g. "1") are authored independently per Notion page, so
// distinct pages routinely reuse the same label. merge-chapters.js then
// concatenates multiple pages into one chapter/section file, where identical
// labels from different source pages collide — Pandoc can't tell which
// [^1]: definition a given [^1] reference belongs to, emits a "Duplicate
// note reference" warning, and silently misattributes one of the footnotes.
// Namespace every label by the source file's index before merging; Pandoc
// auto-numbers rendered footnotes in document order regardless of label
// text, so this has no visible effect on output.
function namespaceFootnotes(body, ns) {
  return body.replace(/\[\^([^\]]+)\]/g, `[^${ns}-$1]`)
}
const nsOf = f => `${f.idx.chap}-${f.idx.sec}-${f.idx.sub}`

function stripInlineSubsections(body, chap, sec) {
  const re = new RegExp(`^# ${chap}\\.${sec}\\.\\d+\\b`, 'm')
  const m  = body.match(re)
  return m ? body.slice(0, m.index) : body
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'
}

function decodeIndex(idx) {
  if (idx == null) return null
  const chap  = Math.floor(idx / 10000)
  const sec   = Math.floor((idx % 10000) / 100)
  const sub   = idx % 100
  const level = sub > 0 ? 3 : sec > 0 ? 2 : 1
  return { chap, sec, sub, level }
}

// Role: prefer the stored meta.role (written by export-pages.js); fall back to
// derivation from index so files exported before the refactor still work.
function getRole(meta) {
  if (meta.role) return meta.role
  const idx = meta.index
  if (idx == null) return 'chrome'
  if (idx < APPARATUS_START) return 'spine'
  return 'apparatus'
}

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (entry.name.endsWith('.qmd')) out.push(p)
  }
  return out
}

function writeBook(fn, yaml, content) {
  fs.writeFileSync(path.join(BOOK, fn), normalizeDivs(yaml + content) + '\n', 'utf8')
}

// ── Load & deduplicate ────────────────────────────────────────────────────────
// export-pages.js writes each Notion page to {slug}.qmd and records that page's
// current slug in data/export-timestamps.json. A page renamed before this file
// existed (or before export-pages.js started cleaning up old-slug files on
// rename) can leave a stale file under its previous slug sitting next to the
// current one, sharing the same notion-id and index. That stale file used to
// be filtered out by keeping whichever of the two had the highest filesystem
// mtime — which silently breaks on a fresh git clone (e.g. every Netlify
// build), where checkout gives every file the same mtime and the "winner" is
// essentially arbitrary. Filtering by the timestamps cache instead is
// deterministic regardless of the filesystem: a file whose own slug doesn't
// match its notion-id's current recorded slug is definitely stale, full stop.
const currentSlugByNotionId = {}
if (fs.existsSync(TIMESTAMPS_PATH)) {
  try {
    const ts = JSON.parse(fs.readFileSync(TIMESTAMPS_PATH, 'utf8'))
    for (const [id, rec] of Object.entries(ts)) if (rec.slug) currentSlugByNotionId[id] = rec.slug
  } catch { /* no cache yet — nothing to filter against */ }
}

const walked = walk(CONTENT).map(fp => {
  const text  = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n')
  const meta  = getYaml(text)
  const mtime = fs.statSync(fp).mtimeMs
  return { fp, meta, body: getBody(text), idx: decodeIndex(meta.index), mtime }
})

const allFiles = walked.filter(f => {
  const wantSlug = f.meta['notion-id'] && currentSlugByNotionId[f.meta['notion-id']]
  if (!wantSlug || wantSlug === f.meta.slug) return true
  console.warn(`WARN skipping stale orphan ${path.relative(CONTENT, f.fp)} — notion-id ${f.meta['notion-id']} is now exported as ${wantSlug}.qmd`)
  return false
})

// Deduplicate: index → file with highest mtime (fallback for the rare case of
// two genuinely different pages colliding on the same index — a real bug the
// filter above can't catch, since it isn't a rename-orphan situation at all).
const byIndex = new Map()
const noIndex = []
for (const f of allFiles) {
  if (f.meta.index == null) { noIndex.push(f); continue }
  const existing = byIndex.get(f.meta.index)
  if (!existing) { byIndex.set(f.meta.index, f); continue }
  if (existing.meta['notion-id'] !== f.meta['notion-id']) {
    console.warn(`WARN index ${f.meta.index} claimed by two different Notion pages: ${path.relative(CONTENT, existing.fp)} and ${path.relative(CONTENT, f.fp)} — keeping the more recently modified`)
  }
  if (f.mtime > existing.mtime) byIndex.set(f.meta.index, f)
}

if (noIndex.length) {
  // Only warn about files that aren't chrome (chrome lives in site/, not here)
  const nonChrome = noIndex.filter(f => getRole(f.meta) !== 'chrome')
  if (nonChrome.length) {
    console.warn(`WARN ${nonChrome.length} content files have no Index — re-run "node export-pages.js --all":`)
    for (const f of nonChrome.slice(0, 5)) console.warn(`  - ${path.relative(CONTENT, f.fp)} ("${f.meta.title}")`)
    if (nonChrome.length > 5) console.warn(`  ... and ${nonChrome.length - 5} more`)
  }
}

const files = [...byIndex.values()]

// ── Categorise by index range ─────────────────────────────────────────────────
// Role is spine for all index < APPARATUS_START, apparatus for >= it, but
// within spine we split further by range for routing.

const frontSpine       = []  // index < 10000
const chapterSpine     = []  // 10000 ≤ index < CONCLUSION_START (main chapters)
const conclusionSpine  = []  // CONCLUSION_START ≤ index < EXCURSUS_START
const excursusSpine    = []  // EXCURSUS_START ≤ index < APPARATUS_START (terminal spine)
const apparatus        = []  // index ≥ APPARATUS_START

for (const f of files) {
  const role = getRole(f.meta)
  if (role === 'chrome') continue
  const idx = f.meta.index
  if (idx < 10000)                  frontSpine.push(f)
  else if (idx < CONCLUSION_START)  chapterSpine.push(f)
  else if (idx < EXCURSUS_START)    conclusionSpine.push(f)
  else if (idx < APPARATUS_START)   excursusSpine.push(f)
  else                              apparatus.push(f)
}

// Slugs routed elsewhere — skip from the front-spine book/ output
const FRONT_SKIP = new Set(['roadmap'])

// ── FRONT SPINE: one front-{slug}.qmd per page ───────────────────────────────
const frontMatterFiles = []
for (const f of frontSpine.sort((a, b) => a.meta.index - b.meta.index)) {
  const title = f.meta.title || 'Untitled'
  const slug  = f.meta.slug  || slugify(title)
  if (FRONT_SKIP.has(slug)) continue
  const fn    = `front-${slug}.qmd`
  const inner = stripFirstH1(f.body).trim()
  const bodyClass = BODY_CLASSES[slug] || ''
  // front-copyright is legal boilerplate, not reading content — excluded
  // from search the same way the rest of the site chrome is. Preface and
  // Introduction stay searchable; they're the start of the reading spine.
  const searchLine = slug === 'copyright' ? 'search: false\n' : ''
  const pagetitle = bareTitle(title)
  const pagetitleLine = pagetitle !== title ? `pagetitle: "${pagetitle.replace(/"/g, '\\"')}"\n` : ''
  const yaml  = `---\ntitle: "${title.replace(/"/g, '\\"')}"\n${pagetitleLine}${bodyClass ? `body-classes: ${bodyClass}\n` : ''}${searchLine}${navFmLines(f.meta)}---\n\n`
  writeBook(fn, yaml, inner)
  frontMatterFiles.push(fn)
}

// ── ROOT index.qmd: the site's landing page is a specific Notion page in
// the Website Content database — identified below by notion-id, not by
// filename — copied to root index.qmd on every rebuild.
//
// Why by notion-id: this page has been renamed (and re-slugged) by the
// author at least twice already — "home" → "about", and it may change
// again. export-pages.js writes each chrome page to site/{slug}.qmd, so a
// rename means export writes a NEW file under the new slug and leaves the
// OLD one sitting on disk untouched (export-pages.js's orphan-removal only
// fires when a page is deleted in Notion, not renamed). Hardcoding
// `site/about.qmd` here broke the second the author renamed the page again
// and this file kept silently reading the stale copy under the old name.
// Scanning site/*.qmd for the matching notion-id and picking whichever
// match has the newest mtime is immune to that: it always finds the
// current export of this page regardless of what it's currently slugged,
// and self-heals if a stale same-ID file is ever left behind again.
//
// Quarto requires index.qmd to exist as the book's first chapter (it errors
// with "Book contents must include a home page" otherwise), so it can't be
// dropped from chapters: for the PDF the way the "About" part is. Instead,
// filters/semantic-blocks.lua drops this chapter's content for LaTeX output
// by matching its title text ("About") — Quarto renders the whole PDF book
// as one merged pandoc document, so a per-file metadata flag here (e.g.
// pdf-exclude: true) would NOT stay scoped to this chapter; it would bleed
// into the merged document's metadata and affect the entire book. If this
// page's title ever changes, update the match in that filter too.
const HOME_PAGE_NOTION_ID = 'd14344cb-db3d-4317-a4c2-01a1909e2a8c'
const SITE_DIR = path.join(ROOT, 'site')
const homeCandidates = fs.existsSync(SITE_DIR)
  ? fs.readdirSync(SITE_DIR)
      .filter(f => f.endsWith('.qmd'))
      .map(f => path.join(SITE_DIR, f))
      .filter(p => getYaml(fs.readFileSync(p, 'utf8'))['notion-id'] === HOME_PAGE_NOTION_ID)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  : []
if (homeCandidates.length > 1) {
  console.warn(`WARN multiple site/*.qmd files share the home page's notion-id — using the newest (${path.basename(homeCandidates[0])}), ignoring stale: ${homeCandidates.slice(1).map(p => path.basename(p)).join(', ')}`)
}
const ABOUT_SRC = homeCandidates[0]
if (ABOUT_SRC) {
  const text  = fs.readFileSync(ABOUT_SRC, 'utf8').replace(/\r\n/g, '\n')
  const title = getYaml(text).title || 'About'
  const inner = stripFirstH1(getBody(text)).trim()
  const yaml  = `---\ntitle: "${title.replace(/"/g, '\\"')}"\nbody-classes: home-page\nsearch: false\n---\n\n`
  // Was two <img src="resources/web-banner-*.png" class="home-title-image
  // home-banner-*"> tags — that markup (and its matching CSS) predates
  // this session's switch to a plain-text title treatment matching
  // resources/web-banner-*.png's typography closely enough that the image
  // itself was retired (styles/custom.css's own .home-title-text-emulation
  // rule has the full reasoning). This script regenerates root index.qmd
  // from scratch on every run and was never updated to match, so the very
  // first `node rebuild.js` after that switch silently reverted the home
  // page straight back to the old, now-unstyled <img> tags — confirmed
  // live: both banner images rendered at their own native size, stacked
  // on top of each other, since the CSS that used to size/toggle them
  // between light and dark mode is gone along with the old markup.
  const homeTitleBlock = `<div class="home-title-text-emulation">\n<div class="home-title-text-main">The Inversion of Greatness</div>\n<div class="home-title-text-subtitle"><span class="home-title-connector">from the</span> <em>Nature of Necessity</em> <span class="home-title-connector">to</span> <em>Maximum Possibility</em></div>\n</div>\n\n::: {.home-title-divider aria-hidden="true"}\n:::\n\n`
  fs.writeFileSync(path.join(ROOT, 'index.qmd'), normalizeDivs(yaml + homeTitleBlock + inner) + '\n', 'utf8')
} else {
  console.warn(`WARN no site/*.qmd file found with notion-id ${HOME_PAGE_NOTION_ID} — root index.qmd not regenerated.`)
}

// ── CHAPTERS 1-CHAPTER_COUNT: one merged file per chapter ────────────────────
// Build section/subsection buckets from chapterSpine only (10000-CONCLUSION_START-1).
const chapBuckets  = new Map()
const chapPartRoot = new Map()  // chap level-1 files (part roots)
for (const f of chapterSpine) {
  if (f.idx.level === 1) { chapPartRoot.set(f.idx.chap, f); continue }
  const key = `${f.idx.chap}.${f.idx.sec}`
  if (!chapBuckets.has(key)) chapBuckets.set(key, { chap: f.idx.chap, sec: f.idx.sec, parent: null, subs: [] })
  const b = chapBuckets.get(key)
  if (f.idx.level === 2) b.parent = f
  else b.subs.push(f)
}

const chapterOutputFiles = {}
for (let chap = 1; chap <= CHAPTER_COUNT; chap++) {
  const buckets  = [...chapBuckets.values()].filter(b => b.chap === chap).sort((a, b) => a.sec - b.sec)
  const partRoot = chapPartRoot.get(chap)
  if (!partRoot && !buckets.length) continue
  const chapTitle = partRoot?.meta?.title || CHAPTER_TITLES[chap] || `Chapter ${chap}`
  const chapSlug  = partRoot?.meta?.slug  || slugify(chapTitle)
  const fn = `${chapSlug}.qmd`
  const parts = []
  if (partRoot) {
    const inner = stripFirstH1(namespaceFootnotes(partRoot.body, nsOf(partRoot))).trim()
    if (inner) parts.push(shiftHeadings(inner, 1))
  }
  for (const b of buckets) {
    const parent   = b.parent
    const secTitle = parent?.meta?.title || `Section ${chap}.${b.sec}`
    const secParts = [`## ${secTitle} {#sec-${chap}-${b.sec}}`]
    if (parent) {
      let inner = stripFirstH1(namespaceFootnotes(parent.body, nsOf(parent))).trim()
      if (b.subs.length) inner = stripInlineSubsections(inner, chap, b.sec).trim()
      if (inner) secParts.push(shiftHeadings(inner, 1))
    }
    for (const sub of b.subs.sort((a, b) => a.idx.sub - b.idx.sub)) {
      const inner = stripFirstH1(namespaceFootnotes(sub.body, nsOf(sub))).trim()
      secParts.push(`### ${sub.meta.title} {#sec-${chap}-${b.sec}-${sub.idx.sub}}\n\n${shiftHeadings(inner, 2)}`)
    }
    parts.push(secParts.join('\n\n'))
  }
  const yaml = `---\ntitle: "${chapTitle.replace(/"/g, '\\"')}"\n---\n\n`
  const chapContent = chap >= CHAPTER_COUNT - 2 ? wrapTocDepth(parts.join('\n\n').trim()) : parts.join('\n\n').trim()
  writeBook(fn, yaml, chapContent)
  chapterOutputFiles[chap] = fn
}

// ── CONCLUSION: single file, after the last main chapter ─────────────────────
let conclusionFile = null
for (const f of conclusionSpine.sort((a, b) => a.meta.index - b.meta.index)) {
  const title = f.meta.title || 'Conclusion'
  const slug  = f.meta.slug  || slugify(title)
  const fn    = `${slug}.qmd`
  const inner = stripFirstH1(f.body).trim()
  const pagetitle = bareTitle(title)
  const pagetitleLine = pagetitle !== title ? `pagetitle: "${pagetitle.replace(/"/g, '\\"')}"\n` : ''
  const yaml  = `---\ntitle: "${title.replace(/"/g, '\\"')}"\n${pagetitleLine}---\n\n`
  writeBook(fn, yaml, inner)
  conclusionFile = fn  // if multiple (shouldn't happen), last one wins
}

// ── EXCURSUS: terminal spine, merged into single file ─────────────────────────
// Lowest index = landing page (intro + title); remainder = ## sections in index order.
let excursusFile = null
if (excursusSpine.length) {
  const sorted  = excursusSpine.sort((a, b) => a.meta.index - b.meta.index)
  const landing = sorted[0]
  const subs    = sorted.slice(1)
  const title   = landing.meta.title || 'Excursus'
  const parts   = []
  const landingInner = stripFirstH1(namespaceFootnotes(landing.body, nsOf(landing))).trim()
  if (landingInner) parts.push(landingInner)
  for (const f of subs) {
    const secTitle = f.meta.title || 'Untitled'
    const slug     = f.meta.slug  || slugify(secTitle)
    const inner    = stripFirstH1(namespaceFootnotes(f.body, nsOf(f))).trim()
    // Excursus entries now come in three shapes: a group header ("E.1
    // Evil and Theodicy", short intro text, no leaf number), a leaf
    // entry nested under it ("E.1.1 Greatest Good", the real content),
    // or a standalone closer with no E.N number at all ("Coda: ...").
    // Group headers (and Coda) keep the old flat "## " level; leaves
    // nest one level deeper ("### ") under whichever group most
    // recently preceded them in index order, so the book's own heading
    // depth reflects the real three-level structure instead of
    // flattening every E.N.M entry to the same rank as its own E.N
    // parent — link-table-of-contents.js's {#anchor} heading scan
    // already reads levels 1-3, so no change needed there for this.
    const isLeaf = /^E\.\d+\.\d+\b/.test(secTitle)
    const level  = isLeaf ? 3 : 2
    parts.push(`${'#'.repeat(level)} ${secTitle} {#sec-${slug}}\n\n${shiftHeadings(inner, level - 1)}`)
  }
  const pagetitle = bareTitle(title)
  const pagetitleLine = pagetitle !== title ? `pagetitle: "${pagetitle.replace(/"/g, '\\"')}"\n` : ''
  const yaml = `---\ntitle: "${title.replace(/"/g, '\\"')}"\n${pagetitleLine}---\n\n`
  writeBook('excursus.qmd', yaml, parts.join('\n\n').trim())
  excursusFile = 'excursus.qmd'
}

// ── APPARATUS: appendices (A-D) + back matter ─────────────────────────────────
// Appendices are placed in chapters: (with the "Appendix X:" label baked
// into the title) instead of Quarto's book.appendices: key. Quarto's
// appendices: key always renders after the *entire* chapters: list with no
// way to put anything after it, which would force the subject index — which
// belongs last, per standard back-matter convention — to sit before the
// appendices. Letters are assigned by encounter order (ascending section
// number), matching the old A→D order that book.appendices: produced.
const appBuckets  = new Map()
const appPartRoot = new Map()
for (const f of apparatus) {
  if (f.idx.level === 1) { appPartRoot.set(f.idx.chap, f); continue }
  const key = `${f.idx.chap}.${f.idx.sec}`
  if (!appBuckets.has(key)) appBuckets.set(key, { chap: f.idx.chap, sec: f.idx.sec, parent: null, subs: [] })
  const b = appBuckets.get(key)
  if (f.idx.level === 2) b.parent = f
  else b.subs.push(f)
}

const APPENDIX_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
let appendixLetterPos = 0

const appendixFiles       = []  // chap 9, sec 1-9  → chapters:, labeled "Appendix A:" etc., before the index
const backMatterChapFiles = []  // sec ≥ 10, except the index → chapters: (notes, glossary, references …)
let indexFile = null            // sec ≥ 10, slug index/subject-index → pinned as the last chapters: entry
let acknowledgmentsFile = null  // slug acknowledg(e)ments → pinned right after Excursus, before the appendices
                                 // (CMOS back-matter order: Acknowledgments, then Appendix, ..., Index)

for (const b of [...appBuckets.values()].sort((a, b) => a.chap - b.chap || a.sec - b.sec)) {
  let parent = b.parent
  // If no level-2 parent exists but there is exactly one subsection, promote
  // that sub to act as the section page rather than emitting a synthetic
  // "Section N.M" placeholder title (which is what caused "Section 12.17" to
  // appear instead of "Symbols" when the Symbols page was indexed at level 3).
  const promotedSub = !parent && b.subs.length === 1 ? b.subs[0] : null
  const title  = parent?.meta?.title || promotedSub?.meta?.title || `Section ${b.chap}.${b.sec}`
  const slug   = parent?.meta?.slug  || promotedSub?.meta?.slug  || slugify(title)
  // "index" slug would clash with book/index.html (the directory default);
  // use "subject-index" for the back-of-book index page specifically.
  const fn     = slug === 'index' ? 'subject-index.qmd' : `${slug}.qmd`
  const parts  = []
  if (parent) {
    let inner = stripFirstH1(namespaceFootnotes(parent.body, nsOf(parent))).trim()
    if (b.subs.length) inner = stripInlineSubsections(inner, b.chap, b.sec).trim()
    // Only shift the parent's own headings down a level when there are real
    // subs getting their own "## Title" wrapper appended below it — that's
    // the only case where the parent's internal ## / ### need to step down
    // to avoid colliding with the subs' heading level. A parent with no subs
    // (e.g. the Modal Logic Primer, Derivation Map, Empirical Predictions
    // appendices — each a single self-contained apparatus file, no split-out
    // sub-files) has nothing to make room for, so its own ## top-level /
    // ### subsection convention should render exactly as authored — matching
    // the numbered chapters' h2/h3 convention instead of being demoted to
    // h3/h4 for no structural reason.
    if (inner) parts.push(b.subs.length ? shiftHeadings(inner, 1) : inner)
  } else if (promotedSub) {
    // Promoted sub: render its content as top-level body (no extra ## wrapper)
    const inner = stripFirstH1(namespaceFootnotes(promotedSub.body, nsOf(promotedSub))).trim()
    if (inner) parts.push(inner)
  }
  for (const sub of b.subs.filter(s => s !== promotedSub).sort((a, b) => a.idx.sub - b.idx.sub)) {
    const inner  = stripFirstH1(namespaceFootnotes(sub.body, nsOf(sub))).trim()
    const anchor = sub.meta.slug ? ` {#sec-${sub.meta.slug}}` : ''
    parts.push(`## ${sub.meta.title}${anchor}\n\n${shiftHeadings(inner, 2)}`)
  }

  const isAcknowledgments = slug === 'acknowledgments' || slug === 'acknowledgements'

  // Files that head a PART_CHILDREN group (e.g. Author's Notes) route to back
  // matter even if their section number falls in the apparatus 1-9 range —
  // they aren't really one of the lettered appendices. Acknowledgments is
  // excluded the same way regardless of which section number it lands on.
  const isAppendix = b.chap === APPARATUS_CHAP && b.sec >= 1 && b.sec <= 9 && !(slug in PART_CHILDREN) && !isAcknowledgments
  const isIndex    = slug === 'subject-index' || slug === 'index'

  let displayTitle = title
  if (isAppendix) {
    // Source titles (authored in Notion) may already carry a hand-written
    // "Appendix X" label — strip it before applying our own, clean one.
    const bareTitle = title.replace(/^Appendix\s+[A-Z]\s*[—–\-:.]\s*/i, '')
    displayTitle = `Appendix ${APPENDIX_LETTERS[appendixLetterPos]}: ${bareTitle}`
    appendixLetterPos++
  }

  const bodyClass = BODY_CLASSES[slug] || ''
  // Apparatus (appendices, back matter, acknowledgments, author's notes, in
  // plain terms) sits outside the reading spine — readers can already reach
  // it via the navbar/sidebar, and it isn't what a search is meant to surface.
  const navMeta = parent?.meta ?? promotedSub?.meta
  const yaml = `---\ntitle: "${displayTitle.replace(/"/g, '\\"')}"\n${bodyClass ? `body-classes: ${bodyClass}\n` : ''}search: false\n${navFmLines(navMeta)}---\n\n`
  let appContent = parts.join('\n\n').trim()
  if (isIndex) appContent = wrapTocDepth(appContent)
  if (isAppendix) appContent = wrapTocDepthAppendix(appContent)
  // Symbols is a short reference page — its own ## headings ("The
  // Conditions", "Variables", etc.) don't need to show as PDF TOC
  // sub-entries under it, same treatment as the lettered appendices.
  if (slug === 'symbols') appContent = wrapTocDepthAppendix(appContent)
  if (slug === 'derivation-map') appContent = applyGlossaryItemFormat(appContent)
  writeBook(fn, yaml, appContent)

  if (isAcknowledgments) acknowledgmentsFile = fn
  else if (isAppendix) appendixFiles.push(fn)
  else if (isIndex) indexFile = fn
  else backMatterChapFiles.push(fn)
}

// Apparatus part-root ("Appendices" landing page) is intentionally not
// placed — placing it would re-letter appendices A-E. Warn only if it
// carries content.
for (const [chap, f] of appPartRoot) {
  if (chap !== APPARATUS_CHAP) {
    const title     = f.meta.title || 'Back matter'
    const slug      = f.meta.slug  || slugify(title)
    const fn        = `${slug}.qmd`
    const inner     = stripFirstH1(f.body).trim()
    const bodyClass = BODY_CLASSES[slug] || ''
    const yaml      = `---\ntitle: "${title.replace(/"/g, '\\"')}"\n${bodyClass ? `body-classes: ${bodyClass}\n` : ''}search: false\n${navFmLines(f.meta)}---\n\n`
    writeBook(fn, yaml, inner ? shiftHeadings(inner, 1) : '')
    backMatterChapFiles.push(fn)
  } else {
    const inner = stripFirstH1(f.body).trim()
    if (inner) console.warn(`WARN chap-9 part-root "${f.meta.title}" has content but is not placed (would re-letter appendices). Move its content into an appendix section or front matter.`)
  }
}

// Back-matter and appendix files are pushed in ascending section-number
// order (the appBuckets loop sorts by sec). Do NOT re-sort alphabetically
// here — that would override the numeric ordering and misplace items like
// Symbols and Notation (slug "symbols", sorts after "references" despite
// having a lower section number and belonging before Glossary).

// Resolve PART_CHILDREN: pull each listed child out of its flat list and
// record it against the parent, so buildQuartoBlock() can nest it under a
// part: entry wherever the parent ends up (chapters: or appendices:).
const slugFromFn = fn => fn.replace(/\.qmd$/, '').replace(/^\d+-\d+-/, '')
const partNesting = new Map() // parent fn -> [child fn, ...]
for (const [parentSlug, childSlugs] of Object.entries(PART_CHILDREN)) {
  const findFn = list => list.find(fn => slugFromFn(fn) === parentSlug)
  const parentFn = findFn(appendixFiles) || findFn(backMatterChapFiles)
  if (!parentFn) continue
  const childFns = []
  for (const slug of childSlugs) {
    const findChild = list => list.find(fn => slugFromFn(fn) === slug)
    const fn = findChild(backMatterChapFiles) || findChild(appendixFiles)
    if (!fn) continue
    childFns.push(fn)
    let i = backMatterChapFiles.indexOf(fn); if (i !== -1) backMatterChapFiles.splice(i, 1)
    i = appendixFiles.indexOf(fn); if (i !== -1) appendixFiles.splice(i, 1)
  }
  if (childFns.length) partNesting.set(parentFn, childFns)
}

// ── Chapter map (used by fix-cross-references.js) ─────────────────────────────
const chapterMap = {}
for (const [chap, fn] of Object.entries(chapterOutputFiles))
  chapterMap[parseInt(chap, 10)] = fn.replace('.qmd', '.html')
fs.writeFileSync(path.join(BOOK, '_chapter-map.json'), JSON.stringify(chapterMap, null, 2) + '\n')

// ── Build _quarto.yml book block ──────────────────────────────────────────────
// chapters: index.qmd → front spine → main chapters → conclusion → excursus →
//           acknowledgments → appendices A-D → back matter (notes, glossary,
//           references) → subject index (always last) — CMOS back-matter order

// Emits either a flat "- book/{fn}" entry, or — if fn has nested children
// via PART_CHILDREN — a "part:"/"chapters:" group at the given indent.
function emitEntry(fn, indent) {
  const children = partNesting.get(fn)
  if (!children) return [`${indent}- book/${fn}`]
  const lines = [`${indent}- part: book/${fn}`, `${indent}  chapters:`]
  for (const c of children) lines.push(`${indent}    - book/${c}`)
  return lines
}

// Slugs hidden from the sidebar (live in navbar menus instead).
// These are emitted as flat chapters outside any part: group so
// Quarto still renders their HTML, but the sidebar JS hides them.
const HIDDEN_BACK_SLUGS = new Set([
  'acknowledgments', 'acknowledgements', 'authors-notes', 'in-plain-terms',
])

function buildQuartoBlock() {
  const lines = []
  lines.push('  chapters:')
  lines.push('    - index.qmd')
  // Linked from the left sidebar's own dedicated "Table of Contents" brand
  // link (injected by JS in _quarto.yml) — not from any navbar menu, and
  // excluded from the normal chapter list by a CSS rule in custom.css, so
  // it needs to exist as a rendered page without appearing twice.
  lines.push('    - site/table-of-contents.qmd')

  // Resources group (hidden in sidebar — see JS rule in _quarto.yml)
  lines.push(`    - part: ${HOME_GROUP.part}`)
  lines.push('      chapters:')
  for (const fn of HOME_GROUP.chapters) lines.push(`        - ${fn}`)

  // front-copyright: hidden flat chapter (rendered but not shown in sidebar)
  const frontCopyrightFn = frontMatterFiles.find(fn => fn.replace('.qmd','').replace(/^\d+-/,'') === 'front-copyright')
  if (frontCopyrightFn) lines.push(`    - book/${frontCopyrightFn}`)

  // Front Matter group (Preface, Introduction — visible in sidebar)
  const frontReadingFiles = frontMatterFiles.filter(fn => fn !== frontCopyrightFn)
  if (frontReadingFiles.length) {
    lines.push('    - part: "Front Matter"')
    lines.push('      chapters:')
    for (const fn of frontReadingFiles) lines.push(`        - book/${fn}`)
  }

  // Chapters group (main reading spine — visible in sidebar)
  const hasChapters = Object.keys(chapterOutputFiles).length || conclusionFile || excursusFile
  if (hasChapters) {
    lines.push('    - part: "Chapters"')
    lines.push('      chapters:')
    for (let chap = 1; chap <= CHAPTER_COUNT; chap++) {
      const fn = chapterOutputFiles[chap]
      if (!fn) continue
      lines.push(`        - book/${fn}`)
    }
    if (conclusionFile) lines.push(`        - book/${conclusionFile}`)
    if (excursusFile)   lines.push(`        - book/${excursusFile}`)
  }

  // Hidden apparatus: acknowledgments, appendices A-D — flat, not in any group
  if (acknowledgmentsFile) lines.push(`    - book/${acknowledgmentsFile}`)
  for (const fn of appendixFiles) lines.push(`    - book/${fn}`)

  // For AI Assistants: flat, hidden site/ chrome page (see FOR_AI_ASSISTANTS above)
  if (fs.existsSync(path.join(ROOT, FOR_AI_ASSISTANTS))) lines.push(`    - ${FOR_AI_ASSISTANTS}`)

  // Reading Guide: flat, hidden site/ chrome page (see READING_GUIDE above)
  if (fs.existsSync(path.join(ROOT, READING_GUIDE))) lines.push(`    - ${READING_GUIDE}`)

  // Hidden back-matter items — flat, outside the Back Matter group
  const hiddenBack = backMatterChapFiles.filter(fn => {
    const slug = fn.replace('.qmd','').replace(/^\d+-\d+-/,'')
    return HIDDEN_BACK_SLUGS.has(slug)
  })
  for (const fn of hiddenBack) lines.push(`    - book/${fn}`)

  // Back Matter group (visible: symbols, glossary, notes, bibliography, index)
  const visibleBack = backMatterChapFiles.filter(fn => {
    const slug = fn.replace('.qmd','').replace(/^\d+-\d+-/,'')
    return !HIDDEN_BACK_SLUGS.has(slug) && fn !== 'bibliography.qmd'
  })
  const hasBackMatter = visibleBack.length ||
    fs.existsSync(path.join(BOOK, 'notes.qmd')) ||
    backMatterChapFiles.includes('bibliography.qmd') ||
    indexFile
  if (hasBackMatter) {
    lines.push('    - part: "Back Matter"')
    lines.push('      chapters:')
    for (const fn of visibleBack) lines.push(...emitEntry(fn, '        '))
    if (fs.existsSync(path.join(BOOK, 'notes.qmd'))) lines.push('        - book/notes.qmd')
    if (backMatterChapFiles.includes('bibliography.qmd')) lines.push('        - book/bibliography.qmd')
    if (indexFile) lines.push(...emitEntry(indexFile, '        '))
  }

  return lines.join('\n') + '\n'
}

const quartoBlock = buildQuartoBlock()

// Fragment (always written) — paste-ready under book:
const frag = [
  '# Generated by merge-chapters.js — paste under `book:` in _quarto.yml',
  quartoBlock,
]
fs.writeFileSync(FRAGMENT, frag.join('\n'))

// Optional in-place rewrite of _quarto.yml
if (WRITE_QUARTO && fs.existsSync(QUARTO)) {
  let yml = fs.readFileSync(QUARTO, 'utf8')
  // Match from "  chapters:" through to blank line before "format:"
  const re = /^( {0,4})chapters:[\s\S]*?(?=^\s*format:)/m
  if (re.test(yml)) {
    fs.writeFileSync(QUARTO + '.bak', yml, 'utf8')
    yml = yml.replace(re, quartoBlock + '\n')
    // The lookahead above stops right after the appendices content (its \s*
    // can span into pre-existing blank lines before "format:"), so any blank
    // lines that were already sitting there survive untouched. Collapse a
    // run of them down to a single separating blank line.
    yml = yml.replace(/\n{3,}(?=format:)/, '\n\n')
    fs.writeFileSync(QUARTO, yml, 'utf8')
    console.log('Rewrote chapters:/appendices: in _quarto.yml (backup at _quarto.yml.bak).')
  } else {
    console.warn('Could not find chapters: … format: region in _quarto.yml — wrote fragment only.')
  }
}

const nChap = Object.keys(chapterOutputFiles).length
const nBack = backMatterChapFiles.length
const nApp  = appendixFiles.length
console.log(
  `\nDone. ${frontMatterFiles.length} front + ${nChap} chapter` +
  (conclusionFile ? ' + conclusion' : '') +
  (excursusFile ? ` + excursus` : '') +
  ` + ${nBack} back-matter + ${nApp} appendix files.` +
  ` Manifest → ${path.basename(FRAGMENT)}` +
  (WRITE_QUARTO ? ' (+ _quarto.yml rewritten)' : '') + '.'
)
