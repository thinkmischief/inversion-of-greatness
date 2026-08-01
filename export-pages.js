// export-pages.js
// Exports pages from two Notion data sources as .qmd files (Quarto markdown).
//
// Sources
//   Book ("The Inversion of Greatness") — manuscript: spine + apparatus.
//   Website Content                      — site chrome: home, about, etc.
//
// Role is derived purely from Index (never from the legacy Web Role property):
//   null index   → chrome   → site/{slug}.qmd
//   index < 90000 → spine   → content/{slug}.qmd
//   index >= 90000 → apparatus → content/{slug}.qmd
//
// Surfaces default to role: spine/apparatus → [Print, Web — Book];
// chrome → [Web — Site]. Per-row Surfaces override the default if set.
//
// Selective: skips pages whose last_edited_time is unchanged since last export.
// Use --all to force a full re-export.

require('dotenv').config()
const { Client } = require('@notionhq/client')
const fs = require('fs')
const path = require('path')

const notion = new Client({ auth: process.env.NOTION_TOKEN })

const CONTENT_DIR = path.join(__dirname, 'content')
const SITE_DIR    = path.join(__dirname, 'site')
const DATA_DIR    = path.join(__dirname, 'data')
if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true })
if (!fs.existsSync(SITE_DIR))    fs.mkdirSync(SITE_DIR,    { recursive: true })
if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR,    { recursive: true })

const BOOK_DS_NAME    = 'The Inversion of Greatness'
const WEBSITE_DS_NAME = 'Website Content'
// Newer, more structured replacement for chrome pages (Nav Section/Nav Order/
// Slug schema) that the author is migrating individual "Website Content"
// pages into over time. A page only lives in ONE of these two data sources
// at once — moving it into "Site" removes it from "Website Content" — so
// this is queried as a genuinely separate source, not a fallback/duplicate
// of the same rows. Querying both means a page's orphan-detection (below)
// keeps tracking it correctly across that move instead of treating the
// move as a deletion and erasing its exported file.
const SITE_DS_NAME    = 'Site'
// "The Mischief" — the author's stable build-directory page (its own ID
// survives renames, unlike a database name lookup). Besides the buildable
// databases dragged into it (Book, Site, future translations), the author
// also drops loose standalone pages directly into it for "little projects
// that aren't quite the book, aren't quite the website" (e.g. "In Plain
// Terms" lives here now, not in any database) — these have no Notion
// database properties at all (no Index, no Slug, no Surfaces), so they're
// handled separately from the data-source queries below.
const HUB_PAGE_ID    = '4718de8f-c522-4ec4-892e-3eb6ab8653b4'
// The hub groups its top-level content into sibling callouts: one
// labeled "Live" holding exactly what's meant to be piped into the site
// (loose pages + the buildable databases), and others (e.g. "In
// Progress") for material that's visibly present but not wired in. Only
// recursing into "Live" means moving something between callouts on the
// Notion side is enough to add/remove it from the build — no code change,
// no hardcoded page-id exclusion list to keep in sync.
const HUB_LIVE_CALLOUT_LABEL = /^live$/i
const TIMESTAMPS_PATH = path.join(DATA_DIR, 'export-timestamps.json')
const FORCE_ALL = process.argv.includes('--all')
// Second body class alongside the standard site-page one, for chrome
// pages that need their own styling hook (keyed by slug, not title —
// slugs are the stable identifier here).
const EXTRA_BODY_CLASSES = {
  'table-of-contents': 'table-of-contents-page',
}

// ── Role derivation (from Index only; never reads Web Role property) ─────────

function deriveRole(index) {
  if (index == null) return 'chrome'
  if (index < 90000) return 'spine'
  return 'apparatus'
}

function isExcursus(index) {
  return index != null && index >= 89500 && index < 90000
}

const ROLE_SURFACE_DEFAULTS = {
  spine:     ['Print', 'Web — Book'],
  apparatus: ['Print', 'Web — Book'],
  chrome:    ['Web — Site'],
}

function resolveSurfaces(page, role) {
  const prop = page.properties?.['Surfaces']
  const explicit = (prop?.multi_select || []).map(s => s.name)
  return explicit.length > 0 ? explicit : (ROLE_SURFACE_DEFAULTS[role] || [])
}

// ── collectPages: unified list from both data sources ────────────────────────

async function collectPages() {
  if (!process.env.NOTION_TOKEN) { console.error('Missing NOTION_TOKEN'); process.exit(1) }
  const entries = []

  console.log(`Finding "${BOOK_DS_NAME}" data source...`)
  const bookDs = await findDataSource(BOOK_DS_NAME)
  if (!bookDs) { console.error(`"${BOOK_DS_NAME}" not found`); process.exit(1) }
  const bookPages = await queryAll(bookDs.id)
  console.log(`${bookPages.length} book pages.`)
  for (const p of bookPages) {
    const index = getPropNumber(p, 'Index')
    const role = deriveRole(index)
    entries.push({ page: p, source: 'book', index, role,
                   surfaces: resolveSurfaces(p, role), excursus: isExcursus(index) })
  }

  console.log(`\nFinding "${WEBSITE_DS_NAME}" data source...`)
  const webDs = await findDataSource(WEBSITE_DS_NAME)
  if (!webDs) {
    console.warn(`"${WEBSITE_DS_NAME}" not found — skipping chrome pages`)
  } else {
    const webPages = await queryAll(webDs.id)
    console.log(`${webPages.length} website pages.`)
    for (const p of webPages) {
      entries.push({ page: p, source: 'website', index: null, role: 'chrome',
                     surfaces: ['Web — Site'], excursus: false })
    }
  }

  console.log(`\nFinding "${SITE_DS_NAME}" data source...`)
  const siteDs = await findDataSource(SITE_DS_NAME)
  if (!siteDs) {
    console.warn(`"${SITE_DS_NAME}" not found — skipping (no pages moved there yet, or the export integration isn't shared with it)`)
  } else {
    const sitePages = await queryAll(siteDs.id)
    console.log(`${sitePages.length} site-database pages.`)
    for (const p of sitePages) {
      entries.push({ page: p, source: 'site-db', index: null, role: 'chrome',
                     surfaces: resolveSurfaces(p, 'chrome'), excursus: false })
    }
  }

  console.log(`\nFinding loose pages directly in the hub ("${HUB_PAGE_ID}")...`)
  const hubPages = await getHubLoosePages(HUB_PAGE_ID)
  console.log(`${hubPages.length} loose hub pages.`)
  for (const p of hubPages) {
    // These have no Notion properties (no Index/Slug/Surfaces) to derive
    // role from — a page that was previously exported some other way (e.g.
    // "In Plain Terms", pulled out of the Book database) keeps its prior
    // role/index/slug from the timestamps cache so it lands in the same
    // file at the same place in the site — the cached index matters
    // because merge-chapters.js silently drops any non-chrome content file
    // that has no numeric index at all. A genuinely new loose page (no
    // cache entry yet) defaults to chrome (site/{slug}.qmd) as the safest
    // generic guess for "standalone, not part of the book's own spine."
    const cached = timestamps[p.id]
    const role = cached?.role || 'chrome'
    entries.push({ page: p, source: 'hub-loose', index: cached?.index ?? null, role,
                   surfaces: cached?.surfaces || resolveSurfaces(p, role), excursus: false })
  }

  console.log(`\n${entries.length} total pages${FORCE_ALL ? ' (forced full export)' : ''}.\n`)
  return entries
}

let timestamps = {}
if (fs.existsSync(TIMESTAMPS_PATH)) {
  try { timestamps = JSON.parse(fs.readFileSync(TIMESTAMPS_PATH, 'utf8')) }
  catch { timestamps = {} }
}

// Notion-icon → semantic-class mapping (Track 2 fix, replaces the old
// Quarto callout-class routing). Unmapped icons default to 'untyped' (a
// plain gray box, no tag asserted), which wrap-premises.js's text-pattern
// pass can still reclassify if the first body line matches a theorem/
// lemma/corollary/definition pattern. Edit to extend with new icon/class
// pairs. Per the locked Callout Box Formatting Guide (Notion). Icon is
// the authoritative classification signal at export time; wrap-premises.js's
// text-pattern matching is the secondary/fallback correction pass for
// anything that falls through without a mapped icon.
//
// Condition entries carry BOTH a shared "condition" class (for the common
// chassis styling — border/padding/background) and one of the three
// letter-specific classes (for the identity color and the box-header
// script's handle/tag derivation), e.g. `{.condition .condition-time}` —
// Pandoc/Quarto fenced divs accept a space-separated multi-class list.
// Determining T/S/Φ straight from the icon (rather than parsing "Condition
// 1, T" out of the body text) is the point: the icon alone is enough.
const ICON_CLASS_MAP = {
  '📐': 'definition',
  '🪨': 'premise',
  '🪞': 'identification',
  '🧭': 'principle',
  '🏛️': 'theorem',
  '🪜': 'lemma',
  '🎯': 'corollary', // Result — CSS class name is still .corollary; displayed tag is "Result"
  '♟️': 'argument',  // Move AND Argument — the guide's one deliberate
                     // exception to one-icon-per-type; which of the two
                     // renders is decided from content shape by the
                     // _quarto.yml header script, not at export time.
  '⏳': 'condition .condition-time',
  '🗺️': 'condition .condition-space',
  '🪙': 'condition .condition-substance',
  // Off the argument-entry type-color legend entirely — these three route
  // straight to Quarto's own native callout-note (plain gray, no box-header
  // JS involved) rather than the typed system above. 📝 is the generic-note
  // family and doubles as the exporter's explicit fallback (see below); 🚪
  // and 📥 are the site-chrome family (reader on-ramp / utility) that in
  // practice only ever appears on Site pages, which already force
  // callout-note regardless of icon — mapped here too so the same box still
  // renders correctly if it's ever authored somewhere isChrome doesn't cover.
  '📝': 'callout-note',
  '🚪': 'callout-note',
  '📥': 'callout-note',
  // Standout line — the rhetorical-pause treatment (styles/custom.css's
  // .standout-line/.standout-tight/.standout-reveal, and filters/
  // semantic-blocks.lua's PDF equivalent). Previously a local-only
  // ::: div wrapper hand-added to content/introduction.qmd after every
  // export — silently wiped twice by a fresh export re-pulling Notion's
  // own plain-text version underneath it. Mapping real Notion callouts
  // to these classes makes the treatment survive re-export like every
  // other semantic box already does, instead of needing to be
  // reapplied by hand each time. Two icons, not one: this pairing (a
  // tight-spaced setup line immediately followed by a held-apart
  // reveal line) is currently the only place standout-line is used, so
  // there's no existing precedent for inferring tight-vs-reveal from
  // content shape the way argument/move disambiguation does — an
  // explicit icon per variant is simpler than inventing one. A third,
  // unmodified '🔹'/'✨'-adjacent icon for the plain (unmodified)
  // .standout-line variant can be added the same way if a future use
  // needs it; none currently does.
  '🔹': 'standout-line .standout-tight',
  '✨': 'standout-line .standout-reveal',
}

// Scaffold/reference boxes (premises lists, proof blocks, argument/thread
// boxes, apparatus/glossary boxes) keep their own icon and are deliberately
// NOT part of the typed-claim system above — no Callout Boxes DB row, no
// type color, no Label-handle-Tag header. Without this set they'd fall
// through to the "unmapped icon" default below and get wrongly forced into
// a typed Premise box.
const SCAFFOLD_ICONS = new Set(['🔢', '∎', '🧵', '🔑'])

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function rt(arr) {
  if (!arr || !arr.length) return ''
  return arr.map(t => {
    let s = t.plain_text
    const a = t.annotations || {}
    if (a.code) s = '`' + s + '`'
    if (a.bold) s = '**' + s + '**'
    if (a.italic) s = '*' + s + '*'
    if (a.strikethrough) s = '~~' + s + '~~'
    if (a.underline) s = '<u>' + s + '</u>'
    if (t.href) s = '[' + s + '](' + t.href + ')'
    return s
  }).join('')
}

function getPropString(page, name) {
  const p = page.properties?.[name]
  if (!p) return null
  if (p.type === 'rich_text') return rt(p.rich_text) || null
  if (p.type === 'title') return rt(p.title) || null
  if (p.type === 'select') return p.select?.name ?? null
  return null
}

function getPropNumber(page, name) {
  const p = page.properties?.[name]
  if (!p) return null
  if (p.type === 'number') return p.number
  if (p.type === 'unique_id') return p.unique_id?.number ?? null
  return null
}

// Nav Section is a multi_select (a page can carry more than one placement —
// e.g. Copyright in both the Resources dropdown and the footer, per author
// request), which getPropString above doesn't handle (that only reads
// rich_text/title/select). Returns an array of selected option names, or
// [] if none are set.
function getPropMultiSelect(page, name) {
  const p = page.properties?.[name]
  if (!p || p.type !== 'multi_select') return []
  return (p.multi_select || []).map(o => o.name)
}

function getPageTitle(page) {
  for (const p of Object.values(page.properties || {})) {
    if (p.type === 'title') return rt(p.title)
  }
  return 'untitled'
}

async function getBlocks(blockId) {
  const all = []
  let cursor
  do {
    const r = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 })
    all.push(...r.results)
    cursor = r.has_more ? r.next_cursor : undefined
  } while (cursor)
  return all
}

// Loose standalone pages dropped directly into the hub page (as opposed to
// the buildable databases dragged in alongside them) — retrieved as full
// page objects so they carry last_edited_time/properties like any other
// entry, even though the only property they actually have is the title.
async function getHubLoosePages(hubId, depth = 0) {
  const children = await getBlocks(hubId)
  const pages = []
  for (const b of children) {
    if (b.type === 'child_page') {
      // Backstop: skip anything titled like the author's "Do Not Touch"
      // container. In practice this never fires — that page sits outside
      // "Live" at the hub's top level, so depth-0 callout-gating below
      // already keeps it (and everything inside it) out of the scan.
      if (/do not touch/i.test(b.child_page?.title || '')) continue
      pages.push(await notion.pages.retrieve({ page_id: b.id }))
    } else if (b.type === 'callout' && depth < 4) {
      // Only descend into the hub's own top-level callouts if this is the
      // one labeled "Live" — the author's designated single source of
      // truth for what's meant to be piped into the site. Sibling
      // callouts (e.g. "In Progress") hold real pages too, but they're
      // deliberately not wired in, so leave them unscanned. Once inside
      // "Live" itself (depth > 0), descend into any further nested
      // callout — we're already inside a trusted container.
      const plainLabel = (b.callout.rich_text || []).map(t => t.plain_text).join('').trim()
      if (depth === 0 && !HUB_LIVE_CALLOUT_LABEL.test(plainLabel)) continue
      pages.push(...await getHubLoosePages(b.id, depth + 1))
    }
  }
  return pages
}

const LIST_ITEM_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do'])

async function blocksToMd(blocks, depth = 0, isChrome = false) {
  const ind = '  '.repeat(depth)
  const out = []
  let lastWasListItem = false
  for (const b of blocks) {
    const d = b[b.type] || {}
    // Pandoc needs a blank line between a list and whatever follows it
    // (a heading, a fenced div, another paragraph) or it swallows that
    // next block as a continuation of the last list item — e.g. a
    // heading right after a bullet renders as literal "## Text" instead
    // of an actual heading. Block-level generation, not a post-hoc
    // line-based patch, so every chrome/content page gets this for free
    // on every export instead of needing a one-off manual fix each time.
    if (lastWasListItem && !LIST_ITEM_TYPES.has(b.type)) out.push('')
    lastWasListItem = LIST_ITEM_TYPES.has(b.type)
    switch (b.type) {
      case 'paragraph': {
        const t = rt(d.rich_text)
        out.push(t ? ind + t : '', '')
        // A paragraph CAN carry its own nested children in Notion (a
        // reader can end up with one by pressing Tab after Enter inside
        // a callout, easy to do by accident) — unlike list items just
        // below, this case never checked for that, so any content
        // nested a level deeper than the paragraph that way was
        // silently dropped rather than exported. Confirmed live: the
        // Home page's own "A living preprint" callout lost everything
        // after its own first line this way — its later paragraphs
        // were nested under that first paragraph, not siblings of it
        // the way "Choose your way in" (the callout just above it,
        // exported correctly) has its own content structured.
        if (b.has_children) out.push(await blocksToMd(await getBlocks(b.id), depth, isChrome))
        break
      }
      case 'heading_1': out.push(ind + '# ' + rt(d.rich_text), ''); break
      case 'heading_2': out.push(ind + '## ' + rt(d.rich_text), ''); break
      case 'heading_3': out.push(ind + '### ' + rt(d.rich_text), ''); break
      case 'bulleted_list_item': {
        out.push(ind + '- ' + rt(d.rich_text))
        if (b.has_children) out.push(await blocksToMd(await getBlocks(b.id), depth + 1, isChrome))
        break
      }
      case 'numbered_list_item': {
        out.push(ind + '1. ' + rt(d.rich_text))
        if (b.has_children) out.push(await blocksToMd(await getBlocks(b.id), depth + 1, isChrome))
        break
      }
      case 'to_do': {
        const c = d.checked ? '[x]' : '[ ]'
        out.push(ind + '- ' + c + ' ' + rt(d.rich_text))
        break
      }
      case 'quote': out.push(ind + '> ' + rt(d.rich_text), ''); break
      case 'code':
        out.push('```' + (d.language || ''), rt(d.rich_text), '```', '')
        break
      case 'divider': out.push('---', ''); break
      case 'callout': {
        // Chrome/site pages never get the book's argument-structure classes
        // (theorem/lemma/definition/premise/etc.) — those are meaningful
        // only inside the manuscript, and wrap-premises.js (which is what
        // actually resolves a bare "untyped" default into its real type)
        // only ever runs on book/ output, never site/. Without this branch,
        // any callout on a site page — regardless of its Notion icon — was
        // silently landing as `.untyped`, rendering an argument-structure
        // box on a page like Contribute or License where that makes no sense.
        //
        // An unmapped icon defaults to "untyped" (a plain neutral-gray box,
        // no tag shown), not "premise" — asserting a specific type for a box
        // whose icon didn't actually match one overstates what's known.
        // wrap-premises.js's text-pattern pass still gets a chance to
        // correct it to its real type from the body content.
        const emoji = d.icon && d.icon.type === 'emoji' ? d.icon.emoji : null
        const semanticClass = isChrome || SCAFFOLD_ICONS.has(emoji)
          ? 'callout-note'
          : (ICON_CLASS_MAP[emoji] || 'untyped')
        const calloutText = rt(d.rich_text)
        out.push(`::: {.${semanticClass}}`)
        // Blank line before the children markdown, or a bulleted/numbered
        // list right after this text (e.g. "**Download options**" leading
        // a list of formats) gets read as a lazy continuation of that line
        // instead of its own list — the same class of bug the sibling-loop
        // fix above guards against, just for a callout's own text vs. its
        // nested children rather than two sibling blocks.
        if (calloutText) out.push(calloutText, '')
        if (b.has_children) out.push(await blocksToMd(await getBlocks(b.id), depth, isChrome))
        out.push('', ':::', '')
        break
      }
      case 'image': {
        const url = d.file?.url || d.external?.url || ''
        out.push('![' + rt(d.caption) + '](' + url + ')', '')
        break
      }
      case 'equation': out.push('$$', d.expression || '', '$$', ''); break
      case 'table': {
        if (b.has_children) {
          const rows = await getBlocks(b.id)
          const hasHeader = d.has_column_header
          const lines = []
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i]
            if (row.type !== 'table_row') continue
            const cells = (row.table_row?.cells || []).map(cell => rt(cell))
            lines.push('| ' + cells.join(' | ') + ' |')
            if (i === 0 && hasHeader) {
              lines.push('| ' + cells.map(() => '---').join(' | ') + ' |')
            }
          }
          if (lines.length) out.push(lines.join('\n'), '')
        }
        break
      }
      case 'table_row': break  // only reached if outside a table block; skip
      case 'toggle': {
        out.push('<details><summary>' + rt(d.rich_text) + '</summary>', '')
        if (b.has_children) out.push(await blocksToMd(await getBlocks(b.id), depth, isChrome))
        out.push('</details>', '')
        break
      }
      case 'child_page': out.push('*[Child page: ' + (d.title || '') + ']*', ''); break
      case 'bookmark':
      case 'embed':
      case 'link_preview':
        out.push('<' + (d.url || '') + '>', '')
        break
      default: break
    }
  }
  return out.join('\n')
}

async function findDataSource(name) {
  let cursor
  do {
    const r = await notion.search({
      filter: { property: 'object', value: 'data_source' },
      start_cursor: cursor, page_size: 100,
    })
    const found = r.results.find(d => {
      const t = (d.title || []).map(x => x.plain_text).join('').trim()
      return t === name || t.toLowerCase() === name.toLowerCase() || t.endsWith(name)
    })
    if (found) return found
    cursor = r.has_more ? r.next_cursor : undefined
  } while (cursor)
  return null
}

async function queryAll(dataSourceId) {
  const all = []
  let cursor
  do {
    const r = await notion.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor, page_size: 100,
    })
    all.push(...r.results)
    cursor = r.has_more ? r.next_cursor : undefined
  } while (cursor)
  return all
}

function escapeYaml(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Convert Notion-style footnote pattern ([1] inline, **[1]** at bottom under
// "**Notes**") into Pandoc footnote syntax ([^1] inline, [^1]: body at bottom).
// Combined with reference-location: margin in _quarto.yml, these render as
// Tufte-style sidenotes in the right margin.
function convertFootnotes(md) {
  // Look for a "**Notes**" block at the end, optionally preceded by "---".
  const notesIdx = md.search(/\n(?:---\s*\n)?\*\*Notes\*\*\s*\n/)
  if (notesIdx === -1) return md

  const before = md.slice(0, notesIdx)
  const after = md.slice(notesIdx).replace(/^\n(?:---\s*\n)?\*\*Notes\*\*\s*\n/, '')

  // Extract each **[N]** ... entry (entries separated by next **[N]** or end).
  const refs = []
  const re = /\*\*\[(\d+)\]\*\*\s*([\s\S]*?)(?=\n\s*\*\*\[\d+\]\*\*|\s*$)/g
  let m
  while ((m = re.exec(after)) !== null) {
    refs.push({ num: m[1], body: m[2].trim().replace(/\n+/g, ' ') })
  }
  if (!refs.length) return md

  // Replace inline [N] with [^N] in the body (only for N's that have definitions).
  let body = before
  for (const { num } of refs) {
    body = body.replace(new RegExp(`\\[${num}\\]`, 'g'), `[^${num}]`)
  }

  // Append Pandoc-style footnote definitions.
  const defs = refs.map(({ num, body }) => `[^${num}]: ${body}`).join('\n\n')
  return body.trimEnd() + '\n\n' + defs + '\n'
}

async function main() {
  let timestamps = {}
  if (fs.existsSync(TIMESTAMPS_PATH)) {
    try { timestamps = JSON.parse(fs.readFileSync(TIMESTAMPS_PATH, 'utf8')) } catch { timestamps = {} }
  }

  const entries = await collectPages()
  const total = entries.length

  // Pre-seed used slugs from timestamps (collision avoidance for auto-slugs)
  const used = new Set(Object.values(timestamps).map(t => t.slug).filter(Boolean))

  let count = 0, skipped = 0, written = 0, failed = 0
  for (const { page, index, role, surfaces, excursus } of entries) {
    count++
    const title = getPageTitle(page) || 'untitled'
    const cached = timestamps[page.id]
    const lastEdited = page.last_edited_time

    // Slug: prefer Notion Slug property → cached → auto-generate
    const notionSlug = getPropString(page, 'Slug')
    let slug
    if (notionSlug) {
      slug = notionSlug
    } else if (cached?.slug) {
      slug = cached.slug
    } else {
      const base = slugify(title) || page.id.slice(0, 8)
      let candidate = base, n = 1
      while (used.has(candidate)) candidate = base + '-' + (++n)
      slug = candidate
    }
    used.add(slug)

    if (!FORCE_ALL && cached?.lastEdited === lastEdited) {
      skipped++
      console.log(`[${count}/${total}] ${title.slice(0, 55).padEnd(55)} ... unchanged`)
      continue
    }

    process.stdout.write(`[${count}/${total}] ${title.slice(0, 55).padEnd(55)} ... `)
    try {
      const blocks = await getBlocks(page.id)
      const md = convertFootnotes(await blocksToMd(blocks, 0, role === 'chrome'))

      // Frontmatter
      // slug is always written from the final resolved `slug` (which
      // already falls back through notionSlug → cached → auto-generated),
      // not just the raw notionSlug property — a page with no explicit
      // Notion Slug property (e.g. a loose hub page like "In Plain Terms")
      // used to get no slug: line at all here, even though its filename
      // WAS correctly resolved via the cached fallback. Without a slug:
      // field, merge-chapters.js has nothing to read and falls back to
      // auto-slugifying the page's title instead, silently producing a
      // different, wrong output filename downstream.
      // Nav Section/Nav Order: which navbar/footer placement(s) this page
      // belongs to and its sort order there — read straight off the
      // Notion page the same way slug is, just above, rather than routing
      // through collectPages(); nothing downstream needs these two before
      // this point. Nav Section is multi_select (a page can carry more
      // than one placement at once, e.g. Copyright in both the Resources
      // dropdown and the footer, on request), so nav-section: writes as a
      // YAML list even when it only has one value, not a bare string.
      const navSection = getPropMultiSelect(page, 'Nav Section')
      const navOrder = getPropNumber(page, 'Nav Order')

      const fmLines = ['---', `title: "${escapeYaml(title)}"`, `notion-id: ${page.id}`]
      if (slug) fmLines.push(`slug: "${escapeYaml(slug)}"`)
      if (index != null) fmLines.push(`index: ${index}`)
      fmLines.push(`role: ${role}`)
      if (navSection.length) fmLines.push(`nav-section: [${navSection.map(s => `"${escapeYaml(s)}"`).join(', ')}]`)
      if (navOrder != null) fmLines.push(`nav-order: ${navOrder}`)
      // Chrome pages get a lighter title-block header than book chapters
      // (see custom.css body.site-page #title-block-header) — they're
      // website pages, not chapter drops, and don't need the same
      // vertical breathing room. index.qmd overrides this itself with
      // body-classes: home-page, so no conflict there. EXTRA_BODY_CLASSES
      // (below) adds a second, page-specific class alongside site-page for
      // the handful of chrome pages that need their own styling hook —
      // same pattern merge-chapters.js already uses for book chapters
      // (its own BODY_CLASSES table), just for the site/ side instead.
      if (role === 'chrome') {
        const extra = EXTRA_BODY_CLASSES[slug]
        fmLines.push(`body-classes: site-page${extra ? ' ' + extra : ''}`)
        // Site chrome (Connect, About, License, Reading Guide, etc.) isn't
        // part of the book's reading spine — a reader searching wants to
        // find argument content, not the pages they can already reach
        // straight from the navbar. Excluded from the site search index.
        fmLines.push('search: false')
      }
      if (surfaces.length) fmLines.push(`surfaces: [${surfaces.map(s => `"${escapeYaml(s)}"`).join(', ')}]`)
      if (excursus) fmLines.push(`excursus: true`)
      // Quarto auto-picks a page's og:image/twitter:image from the first
      // <img> it finds in the body when the page sets none itself —
      // confirmed live: Read and Connect's own Ko-fi support-button image
      // (a raw HTML embed via the "Web build only" pattern) got auto-
      // selected as the page's social-share preview, which is wrong for
      // an incidental UI graphic. Any chrome page whose body embeds a raw
      // <img> this way explicitly falls back to the book's own banner
      // instead, the same image every other page already shows by default.
      // Absolute URL, not a bare relative path — confirmed live: a plain
      // "resources/web-banner-light.png" resolved against this page's own
      // site/ subdirectory instead of the project root, producing a
      // broken .../site/resources/web-banner-light.png og:image URL.
      if (role === 'chrome' && /<img\b/.test(md)) fmLines.push(`image: https://inversionofgreatness.org/resources/web-banner-light.png`)
      fmLines.push('---', '', '')
      const fm = fmLines.join('\n')

      // Route: chrome → site/, everything else → content/
      const outDir = role === 'chrome' ? SITE_DIR : CONTENT_DIR
      fs.writeFileSync(path.join(outDir, slug + '.qmd'), fm + md)
      // A rename (or a role change moving a page between content/ and site/)
      // leaves the page's old file behind under its previous slug — Notion
      // still reports the same last_edited_time bump either way, but nothing
      // else here ever revisits the old filename to remove it. Left alone,
      // these accumulate as orphans that a later build can pick up instead of
      // the current file (this is exactly what broke chapter 6's title and a
      // batch of cross-references: merge-chapters.js's mtime-based dedup
      // picked the stale orphan on Netlify's fresh checkout, where every file
      // gets the same checkout-time mtime). Deleting the old slug's file in
      // both possible directories the moment the new one is written closes
      // that gap at the source.
      if (cached?.slug && cached.slug !== slug) {
        for (const dir of [CONTENT_DIR, SITE_DIR]) {
          const stale = path.join(dir, cached.slug + '.qmd')
          if (fs.existsSync(stale)) fs.unlinkSync(stale)
        }
      }
      // index and surfaces are cached too (not just slug/role) so that a
      // page pulled out of its database into a loose hub page later (see
      // getHubLoosePages) — which has no Index or Surfaces property of its
      // own to read — can still recover the values it had before the move,
      // instead of silently falling back to generic role-based defaults.
      // Without a cached index specifically, merge-chapters.js drops any
      // non-chrome content file that has no numeric index at all.
      timestamps[page.id] = {
        lastEdited, slug, role,
        ...(index != null ? { index } : {}),
        ...(surfaces.length ? { surfaces } : {}),
      }
      written++
      console.log('written')
    } catch (e) {
      failed++
      console.log('failed: ' + e.message)
    }
  }

  // Remove orphans (pages deleted from Notion)
  const currentIds = new Set(entries.map(e => e.page.id))
  let removed = 0
  for (const pageId of Object.keys(timestamps)) {
    if (currentIds.has(pageId)) continue
    const { slug: oldSlug, role: oldRole } = timestamps[pageId] || {}
    if (oldSlug) {
      // Check both dirs since role could have changed
      for (const dir of [CONTENT_DIR, SITE_DIR]) {
        const candidate = path.join(dir, oldSlug + '.qmd')
        if (fs.existsSync(candidate)) { fs.unlinkSync(candidate); removed++ }
      }
    }
    delete timestamps[pageId]
  }

  fs.writeFileSync(TIMESTAMPS_PATH, JSON.stringify(timestamps, null, 2))
  console.log(`\nDone. ${written} written, ${skipped} unchanged, ${failed} failed, ${removed} orphans removed.`)
}

main().catch(err => { console.error('Export failed:', err.message); process.exit(1) })