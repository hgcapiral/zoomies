// Compare two run.cjs result files and list the pages whose panels changed.
//
//   node tools/panel-regression/diff.cjs <old.json> <new.json> [--all]
//
// A change is significant when the panel count differs or a box (in reading order) moves
// more than 2% of the page. Small 1px shifts are counted but not listed unless --all.
// Page numbers are the user's (1-based): page N is index N-1.
const fs = require('fs');

const [oldFile, newFile] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const showAll = process.argv.includes('--all');
const SIGNIFICANT = 0.02;

const before = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
const after = JSON.parse(fs.readFileSync(newFile, 'utf8'));
const fmt = (boxes) => boxes.map(b => `[${[b.x, b.y, b.w, b.h].map(v => v.toFixed(3)).join(' ')}]`).join(' ');

let pages = 0, identical = 0, minor = 0;
const significant = [];
for (const book of new Set([...Object.keys(before), ...Object.keys(after)])) {
  const a = before[book] ?? [], b = after[book] ?? [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    pages++;
    const pa = a[i], pb = b[i];
    if (JSON.stringify(pa) === JSON.stringify(pb)) { identical++; continue; }
    let why = null;
    if (!pa || !pb) why = 'missing';
    else if (pa.length !== pb.length) why = `${pa.length} -> ${pb.length} panels`;
    else {
      const moved = pa.findIndex((p, k) => ['x', 'y', 'w', 'h'].some(key => Math.abs(p[key] - pb[k][key]) > SIGNIFICANT));
      if (moved >= 0) why = `panel ${moved + 1} moved`;
    }
    if (why) significant.push({ book, page: i + 1, why, pa, pb });
    else {
      minor++;
      if (showAll) console.log(`  minor ${book} p${i + 1}`);
    }
  }
}

for (const { book, page, why, pa, pb } of significant) {
  console.log(`${book} p${page}: ${why}`);
  console.log(`   old ${pa ? fmt(pa) : '-'}`);
  console.log(`   new ${pb ? fmt(pb) : '-'}`);
}
console.log(`${pages} pages: ${identical} identical, ${minor} minor shifts, ${significant.length} significant changes`);
