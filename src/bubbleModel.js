// Speech bubble / caption detection with a trained model (worker only).
//
// ogkalu's comic text-and-bubble detector, small int8 version (see public/models/README.md),
// trained on manga, webtoons and Western comics. In a trial on Wolverine, Spider-Man and
// Black Clover it found 86–93% of the bubbles other detectors agreed on, against 57–70% for
// the rules in bubbleDetection.js, and it splits joined balloons and stacked captions.
// It returns boxes only; bubbleDetection.js's bubblesFromBoxes adds shapes and reading order.
//
// onnxruntime-web is imported lazily so this module's bubbleItems can also run outside Vite
// (tools/bubble-model-trial uses it to show exactly what the app does).

const MODEL_URL = '/models/comic-bubbles-v4s-int8.onnx';
const INPUT_SIZE = 640;      // the page is stretched to 640×640 (RT-DETR's processor)
// Classes: 0 balloon or caption, 1 lettering inside one (part of its balloon), 2 text without a balloon
const BALLOON = 0, FREE_TEXT = 2;
const MIN_SCORE = {
  [BALLOON]: 0.3,
  [FREE_TEXT]: 0.5,          // below this, text without a balloon is mostly sound effects and signs
};
const DUPLICATE_IOU = 0.7;   // a box overlapping a likelier one this much is the same thing
const TEXT_IN_BALLOON = 0.5; // text this much inside a kept balloon is that balloon's lettering

let session = null;

/**
 * @param {ImageBitmap} bitmap the page, at any size
 * @returns {Promise<{ x: number, y: number, w: number, h: number, balloon: boolean }[]>}
 *   boxes normalised to 0..1, unordered
 */
export async function detectBubbleBoxes(bitmap) {
  const { ort, imageTensor } = await import('./onnx.js');
  session ??= ort.InferenceSession.create(MODEL_URL);
  const model = await session;
  const { tensor } = imageTensor(bitmap, INPUT_SIZE, { letterbox: false });
  // The model scales its boxes to this size: keep them in input pixels
  const sizes = new ort.Tensor('int64', BigInt64Array.from([BigInt(INPUT_SIZE), BigInt(INPUT_SIZE)]), [1, 2]);
  const { labels, boxes, scores } = await model.run({ images: tensor, orig_target_sizes: sizes });
  return bubbleItems(labels.data, boxes.data, scores.data);
}

/**
 * The model's raw output (300 candidates: class, x1 y1 x2 y2 in input pixels, score) to the
 * balloons/captions and balloon-less text Bubble View steps through.
 */
export function bubbleItems(labels, boxes, scores) {
  const clamp = v => Math.max(0, Math.min(1, v / INPUT_SIZE));
  const candidates = [];
  for (let i = 0; i < scores.length; i++) {
    const c = Number(labels[i]);
    if (!(c in MIN_SCORE) || scores[i] < MIN_SCORE[c]) continue;
    const box = {
      x0: clamp(boxes[i * 4]), y0: clamp(boxes[i * 4 + 1]), x1: clamp(boxes[i * 4 + 2]), y1: clamp(boxes[i * 4 + 3]),
      s: scores[i], balloon: c === BALLOON,
    };
    if (box.x1 > box.x0 && box.y1 > box.y0) candidates.push(box);
  }

  const kept = [];
  for (const b of candidates.sort((a, b) => b.s - a.s)) {
    if (kept.some(k => overlap(b, k) / (area(b) + area(k) - overlap(b, k)) >= DUPLICATE_IOU)) continue;
    kept.push(b);
  }
  return kept
    .filter(b => b.balloon || kept.every(k => !k.balloon || overlap(b, k) < area(b) * TEXT_IN_BALLOON))
    .map(b => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, balloon: b.balloon }));
}

const area = b => (b.x1 - b.x0) * (b.y1 - b.y0);
const overlap = (a, b) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
