#!/usr/bin/env node

/**
 * rebuild.js - Build pipeline orchestrator
 * Runs all transformation steps in sequence
 */

const { execSync } = require('child_process');
const path = require('path');

const commands = [
  // --all (not selective): data/export-timestamps.json is committed to git,
  // so a fresh Netlify checkout carries the same cache a local machine has —
  // and a page whose ONLY change is a property edit (e.g. Nav Section/Nav
  // Order, set from Notion mobile) was observed NOT bumping last_edited_time
  // as seen by dataSources.query in time for the very next build, leaving
  // the selective skip silently stale. Full re-export costs under a minute
  // against a `quarto render` that takes several, so this trades a small
  // amount of build time for actually trusting every Notion edit reaches
  // the live site — the entire point of the Notion-driven nav system.
  'node export-pages.js --all',
  // restore-table-of-contents.js used to run here, overwriting
  // site/table-of-contents.qmd's Notion-exported content with a local
  // template (data/table-of-contents-body.md) on every rebuild — the
  // page had a notion-id and looked live-edited from Notion, but
  // Notion's own copy was silently discarded every time. It drifted
  // badly: wrong chapter file links after a chapter retitle, several
  // Excursus entries missing entirely, and none of the descriptive
  // prose the real Notion page had grown since. Removed so this page
  // behaves like every other exported page now — Notion is the
  // source of truth for its content. link-table-of-contents.js (below)
  // is a much narrower successor: it doesn't touch the page's content
  // at all, only adds hrefs to entries Notion wrote as plain bold
  // text, reading every anchor fresh from the real chapter files each
  // run instead of keeping its own copy of the book's structure.
  'node link-table-of-contents.js',
  // Reads the Annotation database (Notion) directly, not an exported
  // .qmd — inserts each "Placed"/"Margin note" row into its target
  // content/*.qmd section, right after its own Anchor text. Runs
  // before merge-chapters.js so the inserted ::: {.column-margin}
  // blocks are already in place when chapters get assembled, and
  // every later prose-fixing step sees them as if they'd always been
  // there.
  'node attach-margin-notes.js',
  'node inject-live-widgets.js',
  'node build-bibliography.js',
  'node merge-chapters.js --write-quarto',
  // Rewrites the navbar: right: and page-footer: center: blocks in
  // _quarto.yml from nav-section/nav-order frontmatter on site/*.qmd and
  // book/*.qmd (itself sourced from the Nav Section/Nav Order Notion
  // properties) — lets the author control navbar/footer placement
  // entirely from Notion. Must run after merge-chapters.js --write-quarto
  // (needs book/*.qmd to exist with that frontmatter already forwarded)
  // and before quarto render; placed here, before the content-fixing
  // steps below, since it only touches _quarto.yml, not book/*.qmd.
  'node build-navigation.js --write-quarto',
  'node combine-references.js',
  // Overwrites whatever combine-references.js just assembled from the
  // three hand-typed Notion pages (content/references-a-f/g-o/p-z.qmd)
  // with a version generated straight from the References database,
  // filtered to exactly the citekeys actually used somewhere in
  // content/*.qmd. Confirmed via direct comparison that the hand-typed
  // pages had drifted ~280 citations behind what the text actually
  // cites — this closes that gap on every rebuild instead of once.
  // Must run after combine-references.js (whose output it replaces)
  // and after build-bibliography.js (whose data/references.json it
  // reads) — both already earlier in this list.
  'node generate-bibliography.js',
  'node collect-notes.js',
  'node fix-cross-references.js',
  'node fix-titles.js',
  'node add-section-anchors.js',
  'node wrap-premises.js',
  'node fix-prose.js',
  'node validate-book.mjs',
  'quarto render --to html',
  // Removes the dev-only style-preview page (and its search-index
  // entries) from _site/ before the flat public site is assembled —
  // it has to stay a real chapters: entry for `quarto preview` to
  // serve it locally at all (see strip-style-preview.js's own header
  // comment), so this is what actually keeps it out of the published
  // build rather than just unlinked-but-reachable. Must run before
  // flatten-output.js, which copies every book/*.html to the site
  // root and deletes book/ entirely.
  'node strip-style-preview.js',
  'node flatten-output.js',
  'node fix-sitemap.js',
  'node add-canonical-links.js',
  'node add-chapter-descriptions.js',
  'node add-book-structured-data.js',
];

const projectRoot = __dirname;

console.log('Starting build pipeline...\n');

for (const command of commands) {
  try {
    console.log(`\n► Running: ${command}`);
    execSync(command, {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    console.log(`✓ Completed: ${command}`);
  } catch (error) {
    console.error(`\n✗ Failed at: ${command}`);
    console.error(`Exit code: ${error.status}`);
    process.exit(1);
  }
}

console.log('\n✓ Build pipeline completed successfully!');
