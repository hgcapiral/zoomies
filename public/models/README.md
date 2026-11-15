# Bundled detection models

## comic-bubbles-v4s-int8.onnx

Speech bubble / caption detector used by Bubble View (`src/bubbleModel.js`), in comic and manga mode.

- Model: [ogkalu/comic-text-and-bubble-detector](https://huggingface.co/ogkalu/comic-text-and-bubble-detector),
  file `detector-v4-s_int8.onnx` (11.1 MB, int8, SHA-256 `5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79`).
  The card documents the RT-DETR-v2 r50vd model; this small int8 variant is in the same repository
  with the same inputs/outputs: `images` [1,3,640,640] (RGB 0..1, stretched), `orig_target_sizes` [1,2];
  outputs `labels`, `boxes` (x1 y1 x2 y2), `scores` for 300 queries.
- Classes: 0 bubble, 1 text inside a bubble, 2 text outside bubbles.
- Training data: about 11k manga, webtoon, manhua and Western comic pages.
- Licence: **Apache-2.0** (repository licence).

## manga-panels-yolo26n.onnx

Manga panel detector used in Manga mode (`src/mangaPanels.js`).

- Model: [leoxs22/manga-panel-detector-yolo26n](https://huggingface.co/leoxs22/manga-panel-detector-yolo26n),
  Ultralytics YOLO26n fine-tuned on Manga109-s (classes: 0 panel, 1 text), 640×640 input.
- This ONNX file: the export in [c0ffeeOverdose/arn-manga-models](https://huggingface.co/c0ffeeOverdose/arn-manga-models)
  (`panel-yolo26n.onnx`, SHA-256 `d09a3472f827c583a2d3a29a146945cb090223bc90f53ce6f6ba46094db71255`).
- Licence: **AGPL-3.0** (Ultralytics fine-tune; the upstream card corrected an earlier Apache-2.0 label).
  Distributing the app with this model means distributing its source under AGPL-3.0 too.
- Training data: Manga109-s. Results may be used, including commercially, with attribution:
  "Manga109-s" dataset, Aizawa Yamasaki Matsui Lab, The University of Tokyo (http://www.manga109.org/).
