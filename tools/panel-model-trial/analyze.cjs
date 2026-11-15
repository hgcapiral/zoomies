// Summarise a trial run: panel structure found per book, agreement between detectors,
// non-rectangular (slanted) panels, score spread and timings.
//   node analyze.cjs <results.json> [minScore=0.25]
const fs = require('fs');
const results = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const MIN = Number(process.argv[3] || 0.25);
const METHODS = ['rules', 'manga', 'inkwell', 'koharu'];
const BOOKS = ['W001', 'W002', 'W003', 'W004', 'W005', 'W006', 'USM', 'BC01', 'BC02'];
const groups = { comics: b => b[0] === 'W' || b === 'USM', manga: b => b.startsWith('BC') };

const panelsOf = (page, m) => page.res[m].filter(p => p.w * p.h < 0.9 && p.s >= MIN); // as the app filters
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / (a.w * a.h + b.w * b.h - ix * iy);
};
// Same panels (each matched at IoU >= 0.8) and, if `order`, in the same reading order
function agree(a, b, order) {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  if (order) return a.every((p, i) => iou(p, b[i]) >= 0.8);
  const used = new Set();
  return a.every(p => {
    const j = b.findIndex((q, k) => !used.has(k) && iou(p, q) >= 0.8);
    if (j < 0) return false;
    used.add(j);
    return true;
  });
}
const pct = (n, d) => `${((100 * n) / d).toFixed(0)}%`;
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

console.log(`min score ${MIN}\n\nPages with panels found (>= 2 panels), per book:`);
console.log(['book', 'pages', ...METHODS].join('\t'));
for (const book of BOOKS) {
  const pages = results.filter(p => p.book === book);
  console.log([book, pages.length, ...METHODS.map(m => pct(pages.filter(p => panelsOf(p, m).length >= 2).length, pages.length))].join('\t'));
}

for (const [name, inGroup] of Object.entries(groups)) {
  const pages = results.filter(p => inGroup(p.book));
  console.log(`\nAgreement on ${name} (${pages.length} pages): same panels / same panels in the same order`);
  for (let i = 0; i < METHODS.length; i++) for (let j = i + 1; j < METHODS.length; j++) {
    const [a, b] = [METHODS[i], METHODS[j]];
    const same = pages.filter(p => agree(panelsOf(p, a), panelsOf(p, b), false)).length;
    const ordered = pages.filter(p => agree(panelsOf(p, a), panelsOf(p, b), true)).length;
    console.log(`  ${a} vs ${b}: ${pct(same, pages.length)} / ${pct(ordered, pages.length)}`);
  }
  const allModels = pages.filter(p => agree(panelsOf(p, 'manga'), panelsOf(p, 'inkwell')) && agree(panelsOf(p, 'manga'), panelsOf(p, 'koharu')));
  const modelsNotRules = allModels.filter(p => !agree(panelsOf(p, 'rules'), panelsOf(p, 'manga')));
  console.log(`  all 3 models agree: ${pct(allModels.length, pages.length)}; of those, rules differ on ${modelsNotRules.length} pages:`,
    modelsNotRules.slice(0, 25).map(p => `${p.book} p${p.index + 1}`).join(', '));
}

const kp = results.flatMap(p => panelsOf(p, 'koharu').map(q => ({ ...q, page: `${p.book} p${p.index + 1}` })));
const shaped = kp.filter(q => q.fill < 0.85);
console.log(`\nKoharu masks: ${kp.length} panels, ${shaped.length} (${pct(shaped.length, kp.length)}) fill < 85% of their box (non-rectangular):`);
console.log('  ', [...new Set(shaped.map(q => q.page))].slice(0, 30).join(', '));

console.log('\nShare of kept detections scoring under 0.5:');
for (const m of ['manga', 'inkwell', 'koharu']) {
  const ds = results.flatMap(p => p.res[m]);
  console.log(`  ${m}: ${pct(ds.filter(d => d.s < 0.5).length, ds.length)} of ${ds.length}`);
}

console.log('\nMedian ms per page in this run (parallel windows, so slower than a lone worker):');
for (const k of ['decode', ...METHODS]) console.log(`  ${k}: ${median(results.map(p => p.time[k])).toFixed(0)}`);
