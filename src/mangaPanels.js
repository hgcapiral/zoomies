// Manga panel detection with a trained model (worker only).
//
// YOLO26n fine-tuned on Manga109-s (see public/models/README.md), run on the CPU with
// onnxruntime-web. In a trial on Black Clover v01–v02 it found panels on 89% of pages, where
// the rules in panelDetection.js found them on 17–22% (framed panels on white pages, art and
// balloons crossing gutters). The page is letterboxed to 640×640 like Ultralytics does; the
// model's output is already de-duplicated (no NMS needed).
import { ort, imageTensor } from './onnx.js';
import { orderBoxes } from './panelDetection.js';

const MODEL_URL = '/models/manga-panels-yolo26n.onnx';
const INPUT_SIZE = 640;
const PANEL_CLASS = 0;     // the model also finds text (class 1)
const MIN_SCORE = 0.25;    // Ultralytics' default; under 5% of panels in the trial scored below 0.5
const ORDER_SLACK = 0.03;  // boxes may poke this far (fraction of page) across a reading-order cut
const FULL_PAGE = [{ x: 0, y: 0, w: 1, h: 1 }];

let session = null;
export const loadMangaPanelModel = () => (session ??= ort.InferenceSession.create(MODEL_URL));

/**
 * @param {ImageBitmap} bitmap the page, at any size
 * @param {{ rtl?: boolean }} options rtl: read columns right-to-left
 * @returns {Promise<{ x: number, y: number, w: number, h: number }[]>} panels normalised to 0..1,
 *   in reading order; one full-page panel when fewer than two are found (like detectPanels)
 */
export async function detectMangaPanels(bitmap, { rtl = true } = {}) {
  const model = await loadMangaPanelModel();
  const { tensor, toPage } = imageTensor(bitmap, INPUT_SIZE, { letterbox: true });
  const { output0 } = await model.run({ [model.inputNames[0]]: tensor });

  // output0: [1, 300, 6] rows of x1, y1, x2, y2 (input pixels), score, class
  const [, rows, cols] = output0.dims;
  const d = output0.data;
  const grid = v => Math.max(0, Math.min(1000, v * 1000)); // page fraction -> 1000-unit grid
  const boxes = [];
  for (let i = 0; i < rows; i++) {
    const r = i * cols;
    if (d[r + 4] < MIN_SCORE || Math.round(d[r + 5]) !== PANEL_CLASS) continue;
    const box = {
      x0: grid(toPage.x(d[r])), y0: grid(toPage.y(d[r + 1])),
      x1: grid(toPage.x(d[r + 2])), y1: grid(toPage.y(d[r + 3])),
    };
    if (box.x1 > box.x0 && box.y1 > box.y0) boxes.push(box);
  }
  if (boxes.length < 2) return FULL_PAGE;

  // Boxes are on a 1000×1000 grid, so the slack is the same share of the page on both axes
  const slack = { x: 1000 * ORDER_SLACK, y: 1000 * ORDER_SLACK };
  return orderBoxes(boxes, slack, rtl).map(b => ({
    x: b.x0 / 1000, y: b.y0 / 1000, w: (b.x1 - b.x0) / 1000, h: (b.y1 - b.y0) / 1000,
  }));
}
