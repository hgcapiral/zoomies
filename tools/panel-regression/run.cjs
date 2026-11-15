// Electron main process: run a panel detector over the extracted test pages, decoding them
// the way the app's worker does, in parallel hidden windows.
//
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tools/panel-regression/run.cjs \
//     --work=<workDir> --module=<panelDetection.js> --out=<results.json> [--books=W001,BC01] [--jobs=12]
//
// --module may be any copy of the detector (e.g. `git show HEAD:src/panelDetection.js > base.js`);
// it's imported from a Blob URL, so it must have no imports of its own.
// Results: { "<book>": [ [ {x,y,w,h}, ... ] per page index ] }
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--'))
  .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')]; }));
for (const k of ['work', 'module', 'out']) if (!args[k]) throw new Error(`missing --${k}`);

// Never touch the real app's userData (bookmarks) or another run's
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'panel-regression-')));

const manifest = JSON.parse(fs.readFileSync(path.join(args.work, 'manifest.json'), 'utf8'));
const wanted = args.books ? new Set(args.books.split(',')) : null;
const pages = manifest.filter(p => !wanted || wanted.has(p.book));
const jobs = Math.max(1, Math.min(Number(args.jobs) || 12, pages.length));
const source = fs.readFileSync(args.module, 'utf8');

app.whenReady().then(async () => {
  const started = Date.now();
  let done = 0, lastReport = 0;
  ipcMain.on('page-done', () => {
    done++;
    const pct = Math.floor((100 * done) / pages.length);
    if (pct >= lastReport + 10 || done === pages.length) {
      lastReport = pct - (pct % 10);
      console.log(`${pct}% (${done}/${pages.length}) ${((Date.now() - started) / 1000).toFixed(0)}s`);
    }
  });

  // Shard round-robin so every window gets a mix of books
  const shards = Array.from({ length: jobs }, (_, i) => pages.filter((_, j) => j % jobs === i));
  const shardResults = await Promise.all(shards.map(shard => new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
    });
    win.webContents.on('render-process-gone', (_e, d) => reject(new Error(`renderer gone: ${d.reason}`)));
    const channel = `shard-${win.webContents.id}`;
    ipcMain.once(channel, (_e, result) => { win.destroy(); result.error ? reject(new Error(result.error)) : resolve(result); });
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('run', { channel, source, pages: shard });
    });
    win.loadFile(path.join(__dirname, 'renderer.html'));
  })));

  const results = {};
  for (const shard of shardResults) {
    for (const { book, index, panels } of shard.pages) (results[book] ??= [])[index] = panels;
  }
  fs.writeFileSync(args.out, JSON.stringify(results));
  console.log(`wrote ${args.out} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
