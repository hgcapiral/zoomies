# Panel detection regression run

Run this before keeping any change to `src/panelDetection.js`. It runs an old and a new copy
of the detector over every page of the test books and lists the pages whose panels changed.
Look at every changed page: changes that fix the page you're working on often break others.

The test books and the options the app would use for each (`style`, `rtl`) are in
[`books.cjs`](books.cjs). Use a work folder outside the repo, because the extracted pages
take about 2 GB.

```bash
W=/path/to/scratch/regress

# 1. Extract every page once, in the app's page order (re-running skips existing files)
node tools/panel-regression/extract.cjs "$W"

# 2. Detect with the old and the new detector (any copy of the file works as --module)
git show HEAD:src/panelDetection.js > "$W/base.js"
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tools/panel-regression/run.cjs --work="$W" --module="$W/base.js" --out="$W/base.json"
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tools/panel-regression/run.cjs --work="$W" --module=src/panelDetection.js --out="$W/new.json"

# 3. List significant changes (panel count, or a box moved more than 2% of the page)
node tools/panel-regression/diff.cjs "$W/base.json" "$W/new.json"
```

Notes:
- `env -u ELECTRON_RUN_AS_NODE` is needed in VS Code's terminal, which sets that variable.
- Pages are decoded the way `src/bubbleWorker.js` does it (`createImageBitmap` + `OffscreenCanvas`,
  longest side 1000px). Electron's `nativeImage` resamples differently and gave different panels.
- `run.cjs` loads the detector from a Blob URL, so the module must have no imports.
- `--books=W001,BC01` limits a run to some books; `--jobs=N` sets how many windows run in parallel.
- Page numbers in the diff are 1-based, like the page numbers in the app.
