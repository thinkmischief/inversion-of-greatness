// validate-book.js
// Checks every chapter reference in _quarto.yml against the filesystem.
// Removes references to files that no longer exist, so a deleted section
// can't break `quarto preview` or `quarto render`.

import fs from 'node:fs';

const ymlPath = '_quarto.yml';
const yml = fs.readFileSync(ymlPath, 'utf8');
const lines = yml.split(/\r?\n/);

const kept = [];
const removed = [];

for (const line of lines) {
  const match = line.match(/^\s*-\s+(book\/[\w.-]+\.qmd)\s*$/);
  if (match) {
    const file = match[1];
    if (!fs.existsSync(file)) {
      removed.push(file);
      continue; // drop this line
    }
  }
  kept.push(line);
}

if (removed.length === 0) {
  console.log('✓ All chapter references in _quarto.yml exist on disk.');
} else {
  fs.writeFileSync(ymlPath, kept.join('\n'));
  console.log(`✗ Removed ${removed.length} missing chapter reference(s) from _quarto.yml:`);
  removed.forEach(f => console.log(`   • ${f}`));
}