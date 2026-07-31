// build-navigation.js
// Generates the navbar `right:` list and the `page-footer: center:` line in
// _quarto.yml from `nav-section`/`nav-order` frontmatter on site/*.qmd and
// book/*.qmd — the same two properties the author sets directly in Notion
// (Nav Section, Nav Order), so navbar/footer placement can be controlled
// entirely from Notion, including from the Notion mobile app, without ever
// touching this repo.
//
// Nav Section is multi-select: a page can belong to more than one bucket at
// once (e.g. Copyright in both the Resources dropdown and the Footer).
// "Primary" and "Footer" are the two reserved section names (flat top-level
// navbar items and footer links respectively); any other section name
// becomes a dropdown group, keyed by that name — a brand-new dropdown is
// created just by typing a new Nav Section value in Notion, no separate
// "groups" table needed. A dropdown's own position among the top-level
// navbar items is the minimum Nav Order among its members.
//
// Bibliography and Notes have no Notion page of their own (both are pure
// build artifacts — generate-bibliography.js / collect-notes.js) so they're
// hardcoded below as fixed References-group entries.
//
// Dry-run by default: prints the generated fragments without touching
// _quarto.yml. Pass --write-quarto to back up _quarto.yml to
// _quarto.yml.bak and rewrite the navbar: right: block and the
// page-footer: center: line in place — same backup-then-regex-replace
// convention merge-chapters.js already uses.

const fs   = require('fs')
const path = require('path')

const ROOT    = __dirname
const SITE    = path.join(ROOT, 'site')
const BOOK    = path.join(ROOT, 'book')
const QUARTO  = path.join(ROOT, '_quarto.yml')
const WRITE_QUARTO = process.argv.includes('--write-quarto')

const HARDCODED = [
  { title: 'Bibliography', href: 'book/bibliography.qmd', slug: null, navSection: ['References'], navOrder: 31 },
  { title: 'Notes',        href: 'book/notes.qmd',        slug: null, navSection: ['References'], navOrder: 33 },
]

// The navbar title already links to the book's root page (Quarto's own
// default), so an explicit "Home" entry would be a second, redundant link
// to the same place — the hand-written navbar never had one either. Home
// keeps a Nav Order in Notion (1, ahead of Table of Contents at 2) purely
// for ordering context; it's excluded here rather than rendered.
const HOME_SLUG = 'home'

const NAV_SORT_FALLBACK = 999

function getYaml(text) {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return {}
  const out = {}
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    let val = m[2].trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      try { val = JSON.parse(val) } catch { /* leave as raw string */ }
    } else if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1)
    } else if (/^-?\d+$/.test(val)) {
      val = parseInt(val, 10)
    }
    out[m[1]] = val
  }
  return out
}

function loadPages(dir, hrefPrefix) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.qmd'))
    .map(f => {
      const fp   = path.join(dir, f)
      const text = fs.readFileSync(fp, 'utf8').replace(/\r\n/g, '\n')
      const meta = getYaml(text)
      return {
        title: meta.title,
        slug: meta.slug || null,
        href: `${hrefPrefix}/${f}`,
        navSection: Array.isArray(meta['nav-section']) ? meta['nav-section'] : [],
        navOrder: typeof meta['nav-order'] === 'number' ? meta['nav-order'] : null,
      }
    })
}

const pages = [
  ...loadPages(SITE, 'site'),
  ...loadPages(BOOK, 'book'),
  ...HARDCODED,
]

function sortKey(p) { return [p.navOrder ?? NAV_SORT_FALLBACK, p.title || ''] }
function cmp(a, b) {
  const [ao, at] = sortKey(a), [bo, bt] = sortKey(b)
  return ao - bo || at.localeCompare(bt)
}

const navbarTop = []
const footer    = []
const dropdowns = new Map() // group name -> pages[]
const warnings  = []

for (const p of pages) {
  if (!p.navSection.length) continue
  if (!p.title) { warnings.push(`Page at ${p.href} has nav-section set but no title — skipped.`); continue }
  for (const section of p.navSection) {
    if (section === 'Primary') {
      if (p.slug === HOME_SLUG) continue
      navbarTop.push(p)
    } else if (section === 'Footer') {
      footer.push(p)
    } else {
      if (!dropdowns.has(section)) dropdowns.set(section, [])
      dropdowns.get(section).push(p)
    }
  }
}

navbarTop.sort(cmp)
footer.sort(cmp)
for (const list of dropdowns.values()) list.sort(cmp)

const dropdownEntries = [...dropdowns.entries()].map(([name, list]) => ({
  name, list, order: Math.min(...list.map(p => p.navOrder ?? NAV_SORT_FALLBACK)),
}))
dropdownEntries.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

const topLevel = [
  ...navbarTop.map(p => ({ kind: 'link', order: p.navOrder ?? NAV_SORT_FALLBACK, label: p.title, page: p })),
  ...dropdownEntries.map(d => ({ kind: 'menu', order: d.order, label: d.name, group: d })),
]
topLevel.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))

function yamlEscape(s) { return String(s).replace(/"/g, '\\"') }

// Appendix dropdown items carry their full display title ("Appendix A:
// Modal Logic Primer" — set by merge-chapters.js so the page's own H1/tab
// title reads that way) but the navbar has always shown the short form
// ("A. Modal Logic Primer") inside the already-labeled "Appendices"
// dropdown — this reproduces that shortening rather than changing the look.
function menuLabel(title) {
  const m = /^Appendix\s+([A-Z]):\s*(.+)$/.exec(title || '')
  return m ? `${m[1]}. ${m[2]}` : title
}

function buildNavbarYaml() {
  const lines = ['    right:']
  for (const item of topLevel) {
    if (item.kind === 'link') {
      lines.push(`      - text: "${yamlEscape(item.page.title)}"`)
      lines.push(`        href: ${item.page.href}`)
    } else {
      lines.push(`      - text: "${yamlEscape(item.group.name)}"`)
      lines.push(`        menu:`)
      for (const p of item.group.list) {
        lines.push(`          - text: "${yamlEscape(menuLabel(p.title))}"`)
        lines.push(`            href: ${p.href}`)
      }
    }
  }
  return lines.join('\n') + '\n'
}

function buildFooterLine() {
  const year  = new Date().getFullYear()
  const links = footer.map(p => `[${p.title}](/${p.href.replace(/\.qmd$/, '.html')})`).join(' · ')
  const sep   = links ? ' · ' : ''
  return `    center: "© ${year} Procyon${sep}${links}"\n`
}

const navbarYaml = buildNavbarYaml()
const footerLine = buildFooterLine()

for (const w of warnings) console.warn('WARN', w)

if (!WRITE_QUARTO) {
  console.log('--- navbar: right: (dry run) ---\n')
  console.log(navbarYaml)
  console.log('--- page-footer: center: (dry run) ---\n')
  console.log(footerLine)
  console.log('Pass --write-quarto to rewrite _quarto.yml in place.')
  process.exit(0)
}

if (!fs.existsSync(QUARTO)) {
  console.error('_quarto.yml not found.')
  process.exit(1)
}

let yml = fs.readFileSync(QUARTO, 'utf8')

const navRe    = /^ {4}right:[\s\S]*?(?=^ {2}\S)/m
const footerRe = /^ {4}center: ".*"$/m

if (!navRe.test(yml)) {
  console.error('Could not find navbar: right: block in _quarto.yml — nothing written.')
  process.exit(1)
}
if (!footerRe.test(yml)) {
  console.error('Could not find page-footer: center: line in _quarto.yml — nothing written.')
  process.exit(1)
}

fs.writeFileSync(QUARTO + '.bak', yml, 'utf8')
yml = yml.replace(navRe, navbarYaml)
yml = yml.replace(footerRe, footerLine.replace(/\n$/, ''))
fs.writeFileSync(QUARTO, yml, 'utf8')
console.log('Rewrote navbar: right: and page-footer: center: in _quarto.yml (backup at _quarto.yml.bak).')
