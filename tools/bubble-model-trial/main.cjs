// Bubble-model trial: run the app's bubble detector and several ONNX bubble models (onnxruntime-web, as the
// app's worker would) over the regression test pages; write results, timings and contact sheets.
//
//   electron main.cjs --work=<regress dir> --assets=<dir> --out=<dir> [--jobs=12] [--threads=1]
//                     [--ep=wasm|webgpu] [--pages=<json [{book,index}]>] [--sample=<json [{book,index}]>]
//
// --work: the panel-regression work folder (manifest.json + extracted pages).
// --assets: folder with ort/node_modules/onnxruntime-web and models/<name>/*.onnx (see README.md).
// The manga panel model is served from the repo's public/models (as the app does).
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--'))
  .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; }));
for (const k of ['work', 'assets', 'out']) if (!args[k]) throw new Error(`missing --${k}`);
const S = path.resolve(args.assets);
const REPO = path.resolve(__dirname, '..', '..');
const out = path.resolve(args.out);
fs.mkdirSync(path.join(out, 'rows'), { recursive: true });
fs.mkdirSync(path.join(out, 'sheets'), { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-trial-')));
if (args.ep === 'webgpu') app.commandLine.appendSwitch('enable-unsafe-webgpu');

const manifest = JSON.parse(fs.readFileSync(path.join(args.work, 'manifest.json'), 'utf8'));
const key = p => `${p.book}:${p.index}`;
const pick = args.pages ? new Set(JSON.parse(fs.readFileSync(args.pages, 'utf8')).map(key)) : null;
const pages = manifest.filter(p => !pick || pick.has(key(p)));
const sample = args.sample ? JSON.parse(fs.readFileSync(args.sample, 'utf8')).map(key) : [];
const jobs = Math.max(1, Math.min(Number(args.jobs) || 12, pages.length));

// Static server with cross-origin isolation, so multi-threaded WASM can be tried
const roots = {
  '/ort/': path.join(S, 'ort', 'node_modules', 'onnxruntime-web', 'dist'),
  '/models/': path.join(S, 'models'),
  '/trial/': __dirname,
  '/src/': path.join(REPO, 'src'),
  '/public/': path.join(REPO, 'public'),
};
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const prefix = Object.keys(roots).find(p => url.startsWith(p));
  const file = prefix && path.resolve(roots[prefix], url.slice(prefix.length));
  if (!file || !file.startsWith(path.resolve(roots[prefix]))) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(buf);
  });
});

function openWindow(port) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  const ready = new Promise((resolve, reject) => {
    win.webContents.on('render-process-gone', (_e, d) => reject(new Error(`renderer gone: ${d.reason}`)));
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log(`[renderer] ${message}`); });
    ipcMain.once(`ready-${win.webContents.id}`, () => resolve(win));
  });
  win.loadURL(`http://127.0.0.1:${port}/trial/trial.html?id=${win.webContents.id}`);
  return ready;
}

function call(win, type, payload) {
  return new Promise((resolve, reject) => {
    ipcMain.once(`done-${win.webContents.id}`, (_e, r) => (r.error ? reject(new Error(r.error)) : resolve(r)));
    win.webContents.send(type, payload);
  });
}

app.on('window-all-closed', () => {}); // keep running between the detection and sheet windows

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const started = Date.now();
  let done = 0, lastReport = -10;
  ipcMain.on('page-done', () => {
    const pct = Math.floor((100 * ++done) / pages.length);
    if (pct >= lastReport + 10) { lastReport = pct - (pct % 10); console.log(`${pct}% (${done}/${pages.length}) ${((Date.now() - started) / 1000).toFixed(0)}s`); }
  });

  const shards = Array.from({ length: jobs }, (_, i) => pages.filter((_, j) => j % jobs === i));
  const results = await Promise.all(shards.map(async shard => {
    const win = await openWindow(port);
    const r = await call(win, 'run', {
      pages: shard, sample, threads: Number(args.threads) || 1, ep: args.ep || 'wasm', outDir: out,
      methods: args.methods ? args.methods.split(',') : null, // e.g. rules,app (rules always runs)
    });
    win.destroy();
    return r;
  }));
  const all = results.flatMap(r => r.pages);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(all));
  console.log(`env: ${JSON.stringify(results[0].env)}`);

  // Stack the sampled rows into sheets, 4 rows each, in sample order
  const rows = sample.map(k => path.join(out, 'rows', `${k.replace(':', '-')}.png`)).filter(f => fs.existsSync(f));
  if (rows.length) {
    const win = await openWindow(port);
    const groups = [];
    for (let i = 0; i < rows.length; i += 4) groups.push(rows.slice(i, i + 4));
    await call(win, 'compose', { groups, outDir: path.join(out, 'sheets') });
    win.destroy();
    console.log(`${groups.length} sheets`);
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  server.close();
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
