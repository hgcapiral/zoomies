// Summarise a bubble trial run without ground truth: bubbles per page, and agreement.
//   node analyze.cjs <results.json>
//
// Items from all methods are clustered per page (IoU >= 0.5). There are four independent
// "voters": the rules, the ogkalu family (either ogkalu model), Koharu and kitsumed. For each
// method, "found" = share of the clusters that at least 2 of the OTHER voters agree on which the
// method also has (a recall proxy); "alone" = share of its items no other voter has (likely
// false positives, or bubbles everyone else missed).
const fs = require('fs');
const results = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const METHODS = ['rules', 'ogkalu', 'ogkaluS', 'koharu', 'kitsumed'];
const VOTER = { rules: 'rules', ogkalu: 'ogkalu', ogkaluS: 'ogkalu', koharu: 'koharu', kitsumed: 'kitsumed' };
const groups = { 'Western comics': b => b[0] === 'W' || b === 'USM', manga: b => b.startsWith('BC') };

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / (a.w * a.h + b.w * b.h - ix * iy);
};
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : '-');
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function clusters(page) {
  const cs = [];
  for (const m of METHODS) for (const item of page.res[m]) {
    let best = null, bestIou = 0.5;
    for (const c of cs) {
      if (c.members[m]) continue;
      const v = Math.max(...Object.values(c.members).map(o => iou(o, item)));
      if (v >= bestIou) { best = c; bestIou = v; }
    }
    if (best) best.members[m] = item; else cs.push({ members: { [m]: item } });
  }
  for (const c of cs) c.voters = new Set(Object.keys(c.members).map(m => VOTER[m]));
  return cs;
}

for (const [name, inGroup] of Object.entries(groups)) {
  const pages = results.filter(p => inGroup(p.book));
  console.log(`\n${name}: ${pages.length} pages`);
  console.log(['method', 'per page', 'found', 'alone', 'no-balloon text'].join('\t'));
  const all = pages.map(clusters);
  for (const m of METHODS) {
    let ref = 0, hit = 0, own = 0, alone = 0, text = 0;
    all.forEach((cs, i) => {
      for (const c of cs) {
        const others = [...c.voters].filter(v => v !== VOTER[m]).length;
        if (others >= 2) { ref++; if (c.members[m]) hit++; }
        if (c.members[m]) { own++; if (c.voters.size === 1) alone++; }
      }
      text += pages[i].res[m].filter(b => b.text).length;
    });
    console.log([m.padEnd(8), (own / pages.length).toFixed(1), pct(hit, ref), pct(alone, own), pct(text, own)].join('\t'));
  }
}

console.log('\nMedian ms per page in this run (parallel windows; ogkalu models on CPU, the rest on WebGPU):');
for (const k of ['decode', 'panels', ...METHODS]) console.log(`  ${k}: ${median(results.map(p => p.time[k])).toFixed(0)}`);
