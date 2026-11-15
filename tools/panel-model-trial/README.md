# Panel model trial

Compares the rule-based detector (`src/panelDetection.js`) with three ONNX panel models on the
regression test pages (see `../panel-regression`). It runs them through onnxruntime-web in hidden
Electron windows and decodes pages the way the app's worker does. It writes `results.json`,
per-page timings and contact sheets: four columns per page (rules | manga | Inkwell | Koharu),
panels numbered in reading order, dashed when a model's score is under 0.5.

## Assets (not in the repo)

```
<assets>/ort/node_modules/onnxruntime-web/      npm install onnxruntime-web@1.31.1 in <assets>/ort
<assets>/models/manga-yolo26n/panel-yolo26n.onnx   huggingface.co/c0ffeeOverdose/arn-manga-models (9.8 MB)
<assets>/models/inkwell/best.onnx                  huggingface.co/cedarrapidsboy/inkwell-panel-models (12.3 MB)
<assets>/models/koharu-seg/koharu-yolo26s-seg.onnx huggingface.co/Liiesl/bubble-segment-onnx (42 MB)
```

All three models are Ultralytics fine-tunes (AGPL-3.0); the manga ones are trained on Manga109(-s).

## Run

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tools/panel-model-trial/main.cjs \
  --work="$W" --assets="$A" --out="$OUT" --sample=sample.json --jobs=16
node tools/panel-model-trial/analyze.cjs "$OUT/results.json" [minScore]
```

- `--sample`: JSON list of `{ book, index }` (0-based index) to draw contact sheets for.
- `--pages`: limit the run to such a list. `--jobs=1 --threads=4` or `--ep=webgpu` for timings.
- The Koharu model takes about 9 s per page when 16 windows share the CPU; a full run takes about 18 minutes.
  Without it, a run would take a few minutes.
