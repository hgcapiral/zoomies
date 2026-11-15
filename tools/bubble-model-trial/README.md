# Bubble model trial

Compares the app's bubble detector (`src/bubbleDetection.js`, with the panels the app would use:
the manga model for manga, the rules for comics) with ONNX bubble/text models on the regression
test pages (see `../panel-regression`). Pages are decoded like the app's worker; models run in
onnxruntime-web. Output: `results.json` (bubbles per method per page, in reading order via
`orderByPanel`), timings, and contact sheets with one column per method. Shapes are tinted where a
method gives masks; dashed boxes are text with no balloon (captions, floating text).

## Assets (not in the repo)

```
<assets>/ort/node_modules/onnxruntime-web/              npm install onnxruntime-web@1.31.1 in <assets>/ort
<assets>/models/ogkalu/detector.onnx                    huggingface.co/ogkalu/comic-text-and-bubble-detector (168 MB, Apache-2.0)
<assets>/models/ogkalu/detector-v4-s_int8.onnx          same repo (11.1 MB)
<assets>/models/koharu-seg/koharu-yolo26s-seg.onnx      huggingface.co/Liiesl/bubble-segment-onnx (42 MB, AGPL-3.0)
<assets>/models/kitsumed/model_dynamic.onnx             huggingface.co/kitsumed/yolov8m_seg-speech-bubble (109 MB, GPL-3.0)
```

The manga panel model comes from the repo's `public/models`.

## Run

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tools/bubble-model-trial/main.cjs \
  --work="$W" --assets="$A" --out="$OUT" --pages=pages.json --sample=sample.json --jobs=4 --threads=4 --ep=webgpu
node tools/bubble-model-trial/analyze.cjs "$OUT/results.json"
```

- The `app` column is exactly what the app shows: the small ogkalu model, `bubbleItems` (src/bubbleModel.js)
  and `bubblesFromBoxes` (src/bubbleDetection.js). `--methods=rules,app` compares old and new Bubble View
  only (CPU only, no `--ep` needed; two wide columns per sheet).
- Keep `--jobs` at about 4 with `--ep=webgpu`: 12 windows each opening WebGPU sessions ran out of GPU memory.
- The ogkalu models always run on the CPU: the RT-DETR backbone's AveragePool uses `ceil_mode`, which
  onnxruntime-web 1.31.1's WebGPU kernel doesn't implement, and int8 ops have no WebGPU kernels.
- `analyze.cjs` has no ground truth: it reports how often each method finds bubbles that at least two
  other methods agree on, and how many of its bubbles no other method has. Check the sheets before
  trusting either number.
