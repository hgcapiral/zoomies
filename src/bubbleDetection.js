// Speech bubble / caption detection.
//
// 1. Split the page into flat-colour regions by region growing: neighbouring pixels
//    join a region while they stay close to its running average colour (comparing
//    to the average rather than one seed pixel tolerates JPEG noise in flat colours).
// 2. Keep regions of plausible bubble size and shape (white balloons, coloured
//    caption boxes alike), then let each one grow across gentle shading (captions
//    often have a gradient) up to hard edges; pieces of one caption merge.
// 3. A region is a bubble only if it encloses text: several high-contrast,
//    letter-sized holes of similar height, side by side along a line. Flat areas without
//    lettering (snow, sky, walls) are rejected.
// 4. Order bubbles for reading: by the panel they sit in (panel reading order),
//    then top-to-bottom / left-to-right within the panel.
// 5. Text with no balloon of its own (open balloons, captions printed on the page)
//    lies on a large white background region, too big to be a bubble. Blocks of
//    lettering floating on such regions are found separately and boxed.
// 6. Each bubble also gets a shape mask: its region plus the lettering inside,
//    grown slightly to take in the balloon's outline.
//
// The app now finds bubbles with a trained detector (bubbleModel.js) and uses detectBubbles
// only as a fallback. bubblesFromBoxes turns the detector's boxes into the same output, with
// shape masks from step 1's regions and step 4's reading order.

import { detectPanels, orderBoxes, dilate } from './panelDetection.js';

const COLOR_TOLERANCE = 40;       // RGB distance from a region's average colour to join it
const MIN_AREA = 0.0012;          // region size bounds, as fractions of the page area
const MAX_AREA = 0.1;
const MIN_SIDE = 0.02;            // region box must be at least this fraction of the page's width/height
const MIN_FILL = 0.3;             // region pixels / box area (balloons are ovals, captions rectangles)
const GLYPH_MIN_H = 0.004;        // letter height bounds, as fractions of the page height
const GLYPH_MAX_H = 0.03;
const GLYPH_MAX_W = 0.12;         // touching letters form word-wide blobs; cap their width (fraction of page width)
const MIN_INK_CONTRAST = 70;      // luminance gap between lettering and the region
const MIN_GLYPHS = 4;             // similar-height letters a bubble must contain...
const MIN_GLYPHS_CLEAN = 2;       // ...or this many in a clean balloon (short words like "ELF?")
const CLEAN_MIN_LUM = 200;        // clean balloon: bright and white (not a yellow mask),
const CLEAN_MAX_CHROMA = 40;
const BORDER_REACH = 4;           // how far outward (px) to look for a region's border ink
const MIN_BORDER_CONSISTENCY = 0.75; // outlined: the border has one consistent tone...
const MIN_BORDER_CONTRAST = 90;   // ...that stands out from the inside (balloon ink, caption frame)
const MIN_UNOUTLINED_FILL = 0.6;  // without such a border, only a boxy caption shape is trusted
const MIN_GLYPH_ASPECT = 0.3;     // letters/words are at least this wide for their height; hatching strokes aren't
const MIN_WIDE_SHARE = 0.5;       // ...for at least this share of the letters
const CLEAN_MIN_FILL = 0.5;       // compact (fills its box),
const CLEAN_MIN_COVERAGE = 0.04;  // and not empty (small words sit in roomy balloons)
const MIN_HOLLOW_ASPECT = 0.5;    // outlined lettering: a letter's inside is at least this wide for its height
const MIN_HOLLOW_LETTERS = 8;     // ...and a balloon read that way needs at least this many,
const HOLLOW_HEIGHT_SPREAD = 0.3; // ...within this fraction of their typical height
const MIN_LINED_SHARE = 0.6;      // ...and most of them with a neighbour right beside them on their line
// Artwork that passes as text (faces, flowers, hair: eyes and strokes as "letters"):
const MIN_LETTER_INK = 0.3;       // letters are solid strokes; sketchy hatching fills little of its box...
const DENSE_TEXT_LETTERS = 20;    // ...except in long passages of a thin font, recognisable by their lines
const MIN_RUN = 3;                // a text line: at least this many letters side by side
const MIN_RUN_SHARE = 0.6;        // ...holding this share of the letters in real text
const SMALL_LETTER = 0.012;       // below this height (fraction of the page), short text must be clean:
const MIN_SHORT_TEXT_INK = 0.6;   // its letters are most of the ink inside the region (not a nose, mouth...)
const TINY_LETTER = 0.0068;       // letters this small (eye-sized) must be most of the ink,
const MIN_TINY_TEXT_INK = 0.7;
const DOTS_HEIGHT_SPREAD = 0.02;  // unless they're a row of identical marks: "..." (a face's features vary)
const MIN_BUBBLE_LUM = 170;       // bubbles are bright (white/light balloons)...
const MIN_BUBBLE_CHROMA = 60;     // ...or vividly coloured captions; dull mid-tones are artwork (hats, shadows)
const MIN_TEXT_COVERAGE = 0.1;    // the lettering's bounding box must cover this much of the region's area
                                  // (area, not box: a tail or round corners would make short bubbles look empty)
const MAX_INK_SHARE = 0.55;       // enclosed pixels / (region + enclosed): more means it's not a text container
const BUBBLE_PADDING = 0.006;     // grow boxes a little so the balloon outline is included (fraction of page)
const TAIL_SHARE = 0.15;          // rows/columns under this share of the region's widest are tail, not body
const SHADE_STEP = 24;            // max colour step between neighbouring pixels when growing across shading
const SHADE_DRIFT = 110;          // ...and max distance from the region's own colour
const MAX_SHADE_GROWTH = 1;       // growth beyond this multiple of the original size is a leak: undo it
const FLOAT_BG_LUM = 200;         // floating text: background regions this bright...
const FLOAT_BG_CHROMA = 40;       // ...and this colourless (paper white)
const FLOAT_SURROUND = 0.8;       // share of a letter's surrounding ring that must be background or ink
const FLOAT_MIN_BLOBS = 5;        // a text block needs at least this many letter/word blobs,
const FLOAT_MIN_LINES = 2;        // ...on at least this many lines
const FLOAT_MAX_LETTER = 0.018;   // dialogue-sized letters only (fraction of page height); sound effects are bigger
const FLOAT_MIN_INK = 0.15;       // letters are neither faint specks...
const FLOAT_MAX_INK = 0.75;       // ...nor solid strokes (share of their box that is ink)
// Shapes for a trained detector's balloon boxes (bubblesFromBoxes):
const SHAPE_MIN_FILL = 0.3;       // the balloon's fill covers at least this much of its box...
const SHAPE_MAX_LEAK = 0.15;      // ...and has at most this much more outside all balloon boxes
const SHAPE_RECT_FILL = 0.9;      // a shape filling this much of its own bounding box is a rectangle (caption)...
const SHAPE_SIDE_GAP = 0.04;      // ...which must reach within 2 paddings + this share of the box of each side
const ORDER_SLACK = 0.01;
const NESTED_SHARE = 0.8;       // a panel this much inside another is read within it

const luminance = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} image RGBA (or BGRA) pixels
 * @param {{ rtl?: boolean, style?: 'comic' | 'manga', panels?: object[] }} options rtl: read right-to-left (manga);
 *   panels: the page's panels (normalised, in reading order). Pass them when this image
 *   isn't at the ~1000px scale panel detection is tuned for; otherwise they're detected here
 *   with the `style` pipeline.
 * @returns {{ x: number, y: number, w: number, h: number, mask: { width: number, height: number, data: Uint8Array } }[]}
 *   bubbles normalised to 0..1, in reading order; `mask` is 1 inside the bubble's shape, covering its box
 */
export function detectBubbles(image, { rtl = false, style = 'comic', panels } = {}) {
  const { width, height } = image;
  const { labels, regions } = growRegions(image);

  const pageArea = width * height;
  const candidates = regions
    .filter(r => r.count >= pageArea * MIN_AREA && r.count <= pageArea * MAX_AREA &&
      (r.lum >= MIN_BUBBLE_LUM || Math.max(...r.mean) - Math.min(...r.mean) >= MIN_BUBBLE_CHROMA))
    // Judge the balloon's shape without its tail (a long thin tail makes the box mostly empty)
    .filter(r => trimToBody(labels, width, r))
    .filter(r => {
      const w = r.x1 - r.x0, h = r.y1 - r.y0;
      return w >= width * MIN_SIDE && h >= height * MIN_SIDE && r.count / (w * h) >= MIN_FILL;
    });
  for (const r of candidates) growAcrossShading(image, labels, r);

  const bubbles = candidates
    .filter(r => !r.absorbed && recount(labels, width, r))
    .filter(r => containsText(image, labels, r))
    // Bubbles don't nest: a "bubble" around another is really the background it sits on
    .filter((r, _, all) => !all.some(o => o !== r &&
      o.x0 >= r.x0 && o.y0 >= r.y0 && o.x1 <= r.x1 && o.y1 <= r.y1));

  const pad = Math.round(Math.min(width, height) * BUBBLE_PADDING);
  const boxes = bubbles.map(r => {
    const box = {
      x0: Math.max(0, r.x0 - pad), y0: Math.max(0, r.y0 - pad),
      x1: Math.min(width, r.x1 + pad), y1: Math.min(height, r.y1 + pad),
    };
    box.mask = shapeMask(r, box, pad);
    return box;
  });
  boxes.push(...floatingText(image, labels, regions, boxes));

  return orderByPanel(boxes, panels ?? detectPanels(image, { style, rtl }), width, height, rtl).map(b => ({
    x: b.x0 / width,
    y: b.y0 / height,
    w: (b.x1 - b.x0) / width,
    h: (b.y1 - b.y0) / height,
    mask: b.mask,
  }));
}

/**
 * Bubbles from a trained detector's boxes, in the same form as detectBubbles: each balloon
 * gets the shape of the flat-colour region that fills its box (plus the lettering inside);
 * captions, text without a balloon, and balloons whose fill runs out into the page keep their
 * rectangle.
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} image RGBA pixels
 * @param {{ x: number, y: number, w: number, h: number, balloon: boolean }[]} items boxes normalised to 0..1
 * @param {{ rtl?: boolean, style?: 'comic' | 'manga', panels?: object[] }} options as for detectBubbles
 */
export function bubblesFromBoxes(image, items, { rtl = false, style = 'comic', panels } = {}) {
  const { width, height } = image;
  const { labels } = growRegions(image);
  const pad = Math.round(Math.min(width, height) * BUBBLE_PADDING);
  const boxes = items.map(item => ({
    x0: Math.max(0, Math.floor(item.x * width) - pad),
    y0: Math.max(0, Math.floor(item.y * height) - pad),
    x1: Math.min(width, Math.ceil((item.x + item.w) * width) + pad),
    y1: Math.min(height, Math.ceil((item.y + item.h) * height) + pad),
    balloon: item.balloon,
  })).filter(b => b.x1 > b.x0 && b.y1 > b.y0);

  // How many pixels of each region lie inside any balloon's box: a balloon's fill stays inside
  // its box (or a joined neighbour's), while the page background runs far outside them all
  let maxId = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > maxId) maxId = labels[i];
  const total = new Int32Array(maxId + 1), covered = new Int32Array(maxId + 1);
  const inBalloon = new Uint8Array(width * height);
  for (const b of boxes) {
    if (!b.balloon) continue;
    for (let y = b.y0; y < b.y1; y++) inBalloon.fill(1, y * width + b.x0, y * width + b.x1);
  }
  for (let i = 0; i < labels.length; i++) {
    total[labels[i]]++;
    if (inBalloon[i]) covered[labels[i]]++;
  }

  for (const b of boxes) {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    b.mask = (b.balloon && balloonShape(image, labels, b, total, covered, pad)) ||
      { width: w, height: h, data: new Uint8Array(w * h).fill(1) };
  }

  return orderByPanel(boxes, panels ?? detectPanels(image, { style, rtl }), width, height, rtl).map(b => ({
    x: b.x0 / width,
    y: b.y0 / height,
    w: (b.x1 - b.x0) / width,
    h: (b.y1 - b.y0) / height,
    mask: b.mask,
  }));
}

// The balloon's shape inside its box: the region filling most of the box, grown across gentle
// shading (captions often have a gradient), with the lettering it encloses, grown by `pad` to
// take in the outline. Null (use the whole box) when there's no such region, when it leaks out
// of the balloon boxes (a borderless balloon on the page background), or when it's a rectangle
// that stops short of the box (part of a caption whose shading changes too fast to follow).
function balloonShape({ data, width }, labels, box, total, covered, pad) {
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  const at = k => (box.y0 + Math.floor(k / w)) * width + box.x0 + (k % w); // box pixel -> page pixel
  const counts = new Map();
  for (let k = 0; k < w * h; k++) {
    const id = labels[at(k)];
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  let id = -1, inside = 0;
  for (const [k, n] of counts) if (n > inside) { id = k; inside = n; }
  if (inside < w * h * SHAPE_MIN_FILL || total[id] - covered[id] > inside * SHAPE_MAX_LEAK) return null;

  // The fill: the region, plus neighbouring pixels while the colour changes only gradually
  const fill = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;
  const mean = [0, 0, 0];
  for (let k = 0; k < w * h; k++) {
    if (labels[at(k)] !== id) continue;
    fill[k] = 1;
    queue[tail++] = k;
    const p = at(k) * 4;
    mean[0] += data[p]; mean[1] += data[p + 1]; mean[2] += data[p + 2];
  }
  for (let c = 0; c < 3; c++) mean[c] /= tail;
  for (let head = 0; head < tail;) {
    const k = queue[head++];
    const p = at(k) * 4;
    const x = k % w, y = (k - x) / w;
    const grow = (nk) => {
      if (fill[nk]) return;
      const q = at(nk) * 4;
      const sr = data[q] - data[p], sg = data[q + 1] - data[p + 1], sb = data[q + 2] - data[p + 2];
      if (sr * sr + sg * sg + sb * sb > SHADE_STEP * SHADE_STEP) return;
      const dr = data[q] - mean[0], dg = data[q + 1] - mean[1], db = data[q + 2] - mean[2];
      if (dr * dr + dg * dg + db * db > SHADE_DRIFT * SHADE_DRIFT) return;
      fill[nk] = 1;
      queue[tail++] = nk;
    };
    if (x > 0) grow(k - 1);
    if (x < w - 1) grow(k + 1);
    if (y > 0) grow(k - w);
    if (y < h - 1) grow(k + w);
  }

  // Everything not reachable from the box's edge without crossing the fill is part of the balloon
  const outside = new Uint8Array(w * h);
  tail = 0;
  const seed = (k) => {
    if (!outside[k] && !fill[k]) { outside[k] = 1; queue[tail++] = k; }
  };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  for (let head = 0; head < tail;) {
    const k = queue[head++];
    const x = k % w, y = (k - x) / w;
    if (x > 0) seed(k - 1);
    if (x < w - 1) seed(k + 1);
    if (y > 0) seed(k - w);
    if (y < h - 1) seed(k + w);
  }
  const shape = new Uint8Array(w * h);
  let sx0 = w, sy0 = h, sx1 = 0, sy1 = 0, on = 0;
  for (let k = 0; k < w * h; k++) {
    if (outside[k]) continue;
    shape[k] = 1;
    on++;
    const x = k % w, y = (k - x) / w;
    if (x < sx0) sx0 = x;
    if (x >= sx1) sx1 = x + 1;
    if (y < sy0) sy0 = y;
    if (y >= sy1) sy1 = y + 1;
  }
  // A rectangle (caption) that doesn't reach the box's sides is only part of the caption
  const gapX = pad * 2 + w * SHAPE_SIDE_GAP, gapY = pad * 2 + h * SHAPE_SIDE_GAP;
  const boxy = on >= (sx1 - sx0) * (sy1 - sy0) * SHAPE_RECT_FILL;
  if (boxy && (sx0 > gapX || sy0 > gapY || w - sx1 > gapX || h - sy1 > gapY)) return null;
  return { width: w, height: h, data: dilate(shape, w, h, pad) };
}

// The bubble's filled shape (region + enclosed lettering) inside its padded box, grown by `pad`
function shapeMask(region, box, pad) {
  const rw = region.x1 - region.x0, rh = region.y1 - region.y0;
  const width = box.x1 - box.x0, height = box.y1 - box.y0;
  const shape = new Uint8Array(width * height);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (!region.outside[y * rw + x]) {
        shape[(y + region.y0 - box.y0) * width + x + region.x0 - box.x0] = 1;
      }
    }
  }
  return { width, height, data: dilate(shape, width, height, pad) };
}

// Label every pixel with a flat-colour region id; return stats for regions big enough to matter
function growRegions({ data, width, height }) {
  const n = width * height;
  const labels = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const minCount = n * MIN_AREA;
  const maxDist2 = COLOR_TOLERANCE * COLOR_TOLERANCE;
  const regions = [];

  for (let seed = 0, id = 0; seed < n; seed++) {
    if (labels[seed] >= 0) continue;
    const sp = seed * 4;
    let sr = data[sp], sg = data[sp + 1], sb = data[sp + 2];
    labels[seed] = id;
    let head = 0, tail = 0;
    queue[tail++] = seed;
    let x0 = width, y0 = height, x1 = 0, y1 = 0;

    while (head < tail) {
      const i = queue[head++];
      const x = i % width, y = (i - x) / width;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
      const visit = (j) => {
        if (labels[j] >= 0) return;
        const p = j * 4;
        const dr = data[p] - sr / tail, dg = data[p + 1] - sg / tail, db = data[p + 2] - sb / tail;
        if (dr * dr + dg * dg + db * db <= maxDist2) {
          labels[j] = id;
          queue[tail++] = j;
          sr += data[p]; sg += data[p + 1]; sb += data[p + 2];
        }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y < height - 1) visit(i + width);
    }

    if (tail >= minCount) {
      const mean = [sr / tail, sg / tail, sb / tail];
      regions.push({ id, count: tail, x0, y0, x1, y1, mean, lum: luminance(...mean) });
    }
    id++;
  }
  return { labels, regions };
}

// Shrink a region's box to its body, dropping rows/columns where it's only a thin
// sliver (a balloon's tail). Updates the box and count; false if nothing is left.
function trimToBody(labels, width, region) {
  const { id, x0, y0 } = region;
  const w = region.x1 - x0, h = region.y1 - y0;
  const rows = new Uint32Array(h), cols = new Uint32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (labels[(y + y0) * width + x + x0] === id) { rows[y]++; cols[x]++; }
    }
  }
  const [top, bottom] = bodySpan(rows);
  const [left, right] = bodySpan(cols);
  if (top >= bottom || left >= right) return false;

  let count = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) if (labels[(y + y0) * width + x + x0] === id) count++;
  }
  Object.assign(region, { x0: x0 + left, y0: y0 + top, x1: x0 + right, y1: y0 + bottom, count });
  return true;
}

// [start, end) of the histogram range whose values reach TAIL_SHARE of its peak
function bodySpan(hist) {
  let peak = 0;
  for (const v of hist) if (v > peak) peak = v;
  const min = peak * TAIL_SHARE;
  let start = 0, end = hist.length;
  while (start < end && hist[start] < min) start++;
  while (end > start && hist[end - 1] < min) end--;
  return [start, end];
}

// Extend a region over neighbouring pixels while the colour changes only gradually
// (shaded captions), stopping at hard edges. Pixels taken from other regions move
// over; a candidate that loses most of its pixels this way is marked absorbed.
function growAcrossShading({ data, width, height }, labels, region) {
  const { id, mean } = region;
  const limit = region.count * MAX_SHADE_GROWTH;
  const changed = [], previous = [];
  const queue = [];
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) if (labels[y * width + x] === id) queue.push(y * width + x);
  }

  let { x0, y0, x1, y1 } = region;
  for (let head = 0; head < queue.length && changed.length <= limit; head++) {
    const i = queue[head];
    const x = i % width, y = (i - x) / width;
    const p = i * 4;
    const visit = (j) => {
      if (labels[j] === id) return;
      const q = j * 4;
      const sr = data[q] - data[p], sg = data[q + 1] - data[p + 1], sb = data[q + 2] - data[p + 2];
      if (sr * sr + sg * sg + sb * sb > SHADE_STEP * SHADE_STEP) return;
      const dr = data[q] - mean[0], dg = data[q + 1] - mean[1], db = data[q + 2] - mean[2];
      if (dr * dr + dg * dg + db * db > SHADE_DRIFT * SHADE_DRIFT) return;
      changed.push(j);
      previous.push(labels[j]);
      labels[j] = id;
      queue.push(j);
      const jx = j % width, jy = (j - jx) / width;
      if (jx < x0) x0 = jx;
      if (jx >= x1) x1 = jx + 1;
      if (jy < y0) y0 = jy;
      if (jy >= y1) y1 = jy + 1;
    };
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (y > 0) visit(i - width);
    if (y < height - 1) visit(i + width);
  }

  if (changed.length > limit) {
    // Leaked into the artwork: undo
    for (let k = 0; k < changed.length; k++) labels[changed[k]] = previous[k];
    return;
  }
  Object.assign(region, { x0, y0, x1, y1 });
}

// Refresh a region's pixel count after growth; false (and marked absorbed) if another region took most of it
function recount(labels, width, region) {
  let count = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) if (labels[y * width + x] === region.id) count++;
  }
  if (count < region.count * 0.5) {
    region.absorbed = true;
    return false;
  }
  region.count = count;
  return true;
}

// Does the region enclose lines of lettering?
function containsText({ data, width, height }, labels, region) {
  const { id, x0, y0, x1, y1 } = region;
  const w = x1 - x0, h = y1 - y0;
  const local = (x, y) => (y - y0) * w + (x - x0);

  // Non-region pixels of the box reachable from the box edge are "outside"; the rest are enclosed holes
  const outside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;
  const seedOutside = (x, y) => {
    const k = local(x, y);
    if (!outside[k] && labels[y * width + x] !== id) { outside[k] = 1; queue[tail++] = k; }
  };
  for (let x = x0; x < x1; x++) { seedOutside(x, y0); seedOutside(x, y1 - 1); }
  for (let y = y0; y < y1; y++) { seedOutside(x0, y); seedOutside(x1 - 1, y); }
  for (let head = 0; head < tail;) {
    const k = queue[head++];
    const lx = k % w, ly = (k - lx) / w;
    const step = (nx, ny) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const nk = ny * w + nx;
      if (!outside[nk] && labels[(ny + y0) * width + nx + x0] !== id) { outside[nk] = 1; queue[tail++] = nk; }
    };
    step(lx - 1, ly); step(lx + 1, ly); step(lx, ly - 1); step(lx, ly + 1);
  }
  region.outside = outside; // kept for building the bubble's shape mask

  // Enclosed pixels that contrast with the region are ink (checked on the sharp
  // original, so neighbouring letters stay apart); group ink into letter blobs
  let enclosed = 0;
  const ink = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const lx = k % w, ly = (k - lx) / w;
    const i = (ly + y0) * width + lx + x0;
    if (outside[k] || labels[i] === id) continue;
    enclosed++;
    const p = i * 4;
    if (Math.abs(luminance(data[p], data[p + 1], data[p + 2]) - region.lum) >= MIN_INK_CONTRAST) ink[k] = 1;
  }

  const glyphs = letterBlobs(ink, w, h, width, height);

  // Bubbles are framed: either a consistent contrasting border, or (captions) a boxy shape.
  // Textured artwork that happens to hold letter-like marks (snowy branches) is neither.
  const fill = region.count / (w * h);
  const outlined = hasBorder(data, width, labels, region, outside, w, h);
  if (!outlined && fill < MIN_UNOUTLINED_FILL) return false;

  // Short text is only trusted inside a clean white balloon
  const clean = outlined && fill >= CLEAN_MIN_FILL && region.lum >= CLEAN_MIN_LUM &&
    Math.max(...region.mean) - Math.min(...region.mean) <= CLEAN_MAX_CHROMA;
  const minGlyphs = clean ? MIN_GLYPHS_CLEAN : MIN_GLYPHS;

  if (enclosed / (enclosed + region.count) > MAX_INK_SHARE) return false;
  const textArea = (region.count + enclosed) * (clean ? CLEAN_MIN_COVERAGE : MIN_TEXT_COVERAGE);
  if (looksLikeText(glyphs, minGlyphs, textArea)) return !looksLikeArtwork(glyphs, ink, height);

  // Outlined ("hollow") lettering, common in manga shouts: the outlines of neighbouring
  // letters and lines touch, merging all the ink into one blob too big to be a letter.
  // The letters' insides stay separate and letter-sized, so read those instead. Only in
  // clean balloons, where enclosed balloon-coloured shapes are unlikely to be artwork.
  if (!clean) return false;
  const hollow = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) {
    const lx = k % w, ly = (k - lx) / w;
    if (!outside[k] && !ink[k] && labels[(ly + y0) * width + lx + x0] !== id) hollow[k] = 1;
  }
  // Letter insides are fat and all about one height; gaps between hatching or hair
  // strands are thin or vary. A few letter-like holes are common in artwork, so demand
  // a proper amount of uniform lettering.
  const fat = letterBlobs(hollow, w, h, width, height).filter(g => g.w >= g.h * MIN_HOLLOW_ASPECT);
  if (fat.length < MIN_HOLLOW_LETTERS) return false;
  const typical = fat.map(g => g.h).sort((a, b) => a - b)[fat.length >> 1];
  const hollowLetters = fat.filter(g => Math.abs(g.h - typical) <= typical * HOLLOW_HEIGHT_SPREAD);
  return hollowLetters.length >= MIN_HOLLOW_LETTERS &&
    looksLikeText(hollowLetters, MIN_HOLLOW_LETTERS, textArea);
}

// Connected blobs of a mask (w x h, local to a region's box) that are letter- or word-sized
function letterBlobs(mask, w, h, width, height) {
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const glyphs = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !mask[start]) continue;
    seen[start] = 1;
    let tail = 0;
    queue[tail++] = start;
    let gx0 = w, gy0 = h, gx1 = 0, gy1 = 0;
    for (let head = 0; head < tail;) {
      const k = queue[head++];
      const lx = k % w, ly = (k - lx) / w;
      if (lx < gx0) gx0 = lx;
      if (lx >= gx1) gx1 = lx + 1;
      if (ly < gy0) gy0 = ly;
      if (ly >= gy1) gy1 = ly + 1;
      const step = (nx, ny) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        const nk = ny * w + nx;
        if (!seen[nk] && mask[nk]) { seen[nk] = 1; queue[tail++] = nk; }
      };
      step(lx - 1, ly); step(lx + 1, ly); step(lx, ly - 1); step(lx, ly + 1);
    }
    const gh = gy1 - gy0, gw = gx1 - gx0;
    if (gh >= height * GLYPH_MIN_H && gh <= height * GLYPH_MAX_H && gw <= width * GLYPH_MAX_W) {
      glyphs.push({ x0: gx0, x1: gx1, y0: gy0, y1: gy1, cy: (gy0 + gy1) / 2, h: gh, w: gw, n: tail });
    }
  }
  return glyphs;
}

// Do these blobs read as lines of lettering?
function looksLikeText(glyphs, minGlyphs, textArea) {
  if (glyphs.length < minGlyphs) return false;

  // Letters of one font size...
  const heights = glyphs.map(g => g.h).sort((a, b) => a - b);
  const median = heights[heights.length >> 1];
  const letters = glyphs.filter(g => g.h >= median * 0.6 && g.h <= median * 1.6);
  if (letters.length < minGlyphs) return false;

  // ...shaped like letters or words, not thin hatching strokes
  if (letters.filter(g => g.w >= g.h * MIN_GLYPH_ASPECT).length < letters.length * MIN_WIDE_SHARE) {
    return false;
  }

  // ...forming a text block that fills a good part of the region (and its enclosed lettering)
  const tx0 = Math.min(...letters.map(g => g.x0)), tx1 = Math.max(...letters.map(g => g.x1));
  const ty0 = Math.min(...letters.map(g => g.y0)), ty1 = Math.max(...letters.map(g => g.y1));
  if ((tx1 - tx0) * (ty1 - ty0) < textArea) return false;

  // ...standing side by side on text lines, as letters in words do (scattered specks don't).
  // Touching letters merge into word-wide blobs, so short words may give only one or two.
  const lined = letters.filter(g => letters.some(o => o !== g &&
    Math.abs(o.cy - g.cy) <= median * 0.4 &&
    Math.max(o.x0 - g.x1, g.x0 - o.x1) <= median * 1.2));
  if (lined.length >= 2 && lined.length >= letters.length * MIN_LINED_SHARE) return true;
  return false;
}

// Do these "letters" come from drawn features instead of lettering? Real lettering is
// solid, forms lines of several letters, and makes up nearly all the ink in its balloon;
// a face's eyes or a petal's strokes are sketchy, sparse, few to a line, or share the
// region with other ink (a nose, a mouth).
function looksLikeArtwork(glyphs, ink, height) {
  const median = glyphs.map(g => g.h).sort((a, b) => a - b)[glyphs.length >> 1];
  const letters = glyphs.filter(g => g.h >= median * 0.6 && g.h <= median * 1.6);
  const letterInk = letters.reduce((sum, g) => sum + g.n, 0);
  const density = letterInk / letters.reduce((sum, g) => sum + g.w * g.h, 0);
  let inkTotal = 0;
  for (const v of ink) inkTotal += v;
  const inkShare = letterInk / Math.max(1, inkTotal);

  // Share of the letters standing in lines of MIN_RUN or more
  const line = letters.map((_, i) => i);
  const find = (i) => (line[i] === i ? i : (line[i] = find(line[i])));
  letters.forEach((g, i) => letters.forEach((o, j) => {
    if (j > i && Math.abs(o.cy - g.cy) <= median * 0.4 &&
      Math.max(o.x0 - g.x1, g.x0 - o.x1) <= median * 1.2) line[find(i)] = find(j);
  }));
  const lineSize = new Map();
  letters.forEach((_, i) => lineSize.set(find(i), (lineSize.get(find(i)) ?? 0) + 1));
  const runShare = letters.filter((_, i) => lineSize.get(find(i)) >= MIN_RUN).length / letters.length;

  const size = median / height;
  if (density < MIN_LETTER_INK && !(letters.length >= DENSE_TEXT_LETTERS && runShare >= MIN_RUN_SHARE)) return true;
  if (runShare === 0 && size < SMALL_LETTER && inkShare < MIN_SHORT_TEXT_INK) return true;
  const meanH = letters.reduce((sum, g) => sum + g.h, 0) / letters.length;
  const spread = Math.sqrt(letters.reduce((sum, g) => sum + (g.h - meanH) ** 2, 0) / letters.length) / meanH;
  const dots = letters.length >= MIN_RUN && spread <= DOTS_HEIGHT_SPREAD;
  if (size < TINY_LETTER && inkShare < MIN_TINY_TEXT_INK && !dots) return true;
  return false;
}

// Is the region framed by a consistent, contrasting border? For each step outward
// from its edge, take the most contrasting pixel within BORDER_REACH (past any
// antialiasing); the border is those tones' median, and must be shared by most.
function hasBorder(data, width, labels, region, outside, w, h) {
  const { id, x0, y0, lum } = region;
  const height = labels.length / width;
  const tones = [];
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      if (labels[(ly + y0) * width + lx + x0] !== id) continue;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = lx + dx, ny = ly + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && !outside[ny * w + nx]) continue; // inside or lettering
        let best = null;
        for (let k = 1; k <= BORDER_REACH; k++) {
          const gx = lx + x0 + dx * k, gy = ly + y0 + dy * k;
          if (gx < 0 || gy < 0 || gx >= width || gy >= height) break;
          const p = (gy * width + gx) * 4;
          const tone = luminance(data[p], data[p + 1], data[p + 2]);
          if (best === null || Math.abs(tone - lum) > Math.abs(best - lum)) best = tone;
        }
        if (best !== null) tones.push(best);
      }
    }
  }
  if (tones.length === 0) return false;
  tones.sort((a, b) => a - b);
  const median = tones[tones.length >> 1];
  const consistent = tones.filter(t => Math.abs(t - median) <= 45).length / tones.length;
  return consistent >= MIN_BORDER_CONSISTENCY && Math.abs(median - lum) >= MIN_BORDER_CONTRAST;
}

// Blocks of lettering lying directly on large white background regions (open balloons,
// captions printed on the page). Returns padded boxes with full masks, skipping any
// that overlap `taken` (bubbles already found).
function floatingText({ data, width, height }, labels, regions, taken) {
  const backgrounds = new Set(regions
    .filter(r => r.count > width * height * MAX_AREA && r.lum >= FLOAT_BG_LUM &&
      Math.max(...r.mean) - Math.min(...r.mean) <= FLOAT_BG_CHROMA)
    .map(r => r.id));
  if (backgrounds.size === 0) return [];

  const ink = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    if (luminance(data[p], data[p + 1], data[p + 2]) <= FLOAT_BG_LUM - MIN_INK_CONTRAST) ink[i] = 1;
  }

  // Letters: blobs of moderate ink density, ringed by background or neighbouring
  // letters' ink (tight lettering), not by artwork's mid-tones
  const clear = (i) => backgrounds.has(labels[i]) || ink[i];
  const onBackground = (g) => {
    let ring = 0, bg = 0;
    const x0 = g.x0 - 2, y0 = g.y0 - 2, x1 = g.x1 + 1, y1 = g.y1 + 1;
    for (let x = x0; x <= x1; x++) {
      for (const y of [y0, y1]) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        ring++; if (clear(y * width + x)) bg++;
      }
    }
    for (let y = y0 + 1; y < y1; y++) {
      for (const x of [x0, x1]) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        ring++; if (clear(y * width + x)) bg++;
      }
    }
    return ring > 0 && bg / ring >= FLOAT_SURROUND;
  };
  const letters = letterBlobs(ink, width, height, width, height).filter(g => {
    const density = g.n / (g.w * g.h);
    return density >= FLOAT_MIN_INK && density <= FLOAT_MAX_INK && g.h <= height * FLOAT_MAX_LETTER &&
      g.w >= g.h * MIN_GLYPH_ASPECT && onBackground(g);
  });

  // Group letters into text blocks: neighbours on a line, or on the next line down
  const group = letters.map((_, i) => i);
  const find = (i) => (group[i] === i ? i : (group[i] = find(group[i])));
  for (let i = 0; i < letters.length; i++) {
    for (let j = i + 1; j < letters.length; j++) {
      const a = letters[i], b = letters[j];
      if (Math.max(a.h, b.h) > Math.min(a.h, b.h) * 1.5) continue;
      const m = (a.h + b.h) / 2;
      const gapX = Math.max(b.x0 - a.x1, a.x0 - b.x1);
      const gapY = Math.max(b.y0 - a.y1, a.y0 - b.y1);
      const sameLine = Math.abs(a.cy - b.cy) <= m * 0.5 && gapX <= m * 1.5;
      const nextLine = gapY <= m && gapX <= m * 0.5;
      if (sameLine || nextLine) group[find(i)] = find(j);
    }
  }
  const blocks = new Map();
  letters.forEach((g, i) => {
    const k = find(i);
    if (!blocks.has(k)) blocks.set(k, []);
    blocks.get(k).push(g);
  });

  const found = [];
  for (const block of blocks.values()) {
    if (block.length < FLOAT_MIN_BLOBS) continue;
    const median = block.map(g => g.h).sort((a, b) => a - b)[block.length >> 1];
    const even = block.filter(g => g.h >= median * 0.7 && g.h <= median * 1.4);
    if (even.length < block.length * 0.8) continue;

    // Lines of text, at least one with words/letters side by side
    const lines = [];
    for (const g of [...block].sort((a, b) => a.cy - b.cy)) {
      const line = lines.find(l => Math.abs(l.cy - g.cy) <= median * 0.5);
      if (line) line.items.push(g); else lines.push({ cy: g.cy, items: [g] });
    }
    if (lines.length < FLOAT_MIN_LINES || !lines.some(l => l.items.length >= 2)) continue;

    const pad = Math.round(median * 0.6);
    const box = {
      x0: Math.max(0, Math.min(...block.map(g => g.x0)) - pad),
      y0: Math.max(0, Math.min(...block.map(g => g.y0)) - pad),
      x1: Math.min(width, Math.max(...block.map(g => g.x1)) + pad),
      y1: Math.min(height, Math.max(...block.map(g => g.y1)) + pad),
    };
    if (taken.some(t => overlapArea(t, box) > 0)) continue;
    const w = box.x1 - box.x0, h = box.y1 - box.y0;
    box.mask = { width: w, height: h, data: new Uint8Array(w * h).fill(1) };
    found.push(box);
  }
  return found;
}

// Reading order: panel by panel, then within each panel. Boxes ({x0, y0, x1, y1}) are in
// pixels of a width × height page; panels are normalised, in reading order.
export function orderByPanel(boxes, panels, width, height, rtl) {
  const panelBoxes = panels.map(p => ({
    x0: p.x * width, y0: p.y * height, x1: (p.x + p.w) * width, y1: (p.y + p.h) * height,
  }));
  const groups = panelBoxes.map(() => []);

  for (const b of boxes) {
    // The panel it overlaps most (bubbles often straddle a gutter), else the nearest one
    let bestPanel = 0, bestScore = -Infinity;
    panelBoxes.forEach((p, i) => {
      const overlap =
        Math.max(0, Math.min(b.x1, p.x1) - Math.max(b.x0, p.x0)) *
        Math.max(0, Math.min(b.y1, p.y1) - Math.max(b.y0, p.y0));
      const distance = Math.hypot((b.x0 + b.x1 - p.x0 - p.x1) / 2, (b.y0 + b.y1 - p.y0 - p.y1) / 2);
      // Ties (a bubble fully inside nested panel boxes) go to the smallest panel
      const area = (p.x1 - p.x0) * (p.y1 - p.y0);
      const score = overlap > 0 ? overlap - area * 1e-6 : -distance;
      if (score > bestScore) { bestScore = score; bestPanel = i; }
    });
    groups[bestPanel].push(b);
  }

  const slack = { x: width * ORDER_SLACK, y: height * ORDER_SLACK };

  // A panel lying inside another (an inset, or a panel whose gutter detection merged
  // with its surroundings) is read in its place within the outer panel, as one block,
  // rather than after all of the outer panel's bubbles.
  const parent = panelBoxes.map((p, i) => {
    let best = -1;
    panelBoxes.forEach((q, j) => {
      if (j === i || boxArea(q) <= boxArea(p) || overlapArea(p, q) < boxArea(p) * NESTED_SHARE) return;
      if (best < 0 || boxArea(q) < boxArea(panelBoxes[best])) best = j; // innermost container
    });
    return best;
  });

  // Bubbles of panel i in reading order, with nested panels slotted in as blocks
  const readPanel = (i) => {
    const items = [
      ...groups[i].map(b => ({ ...box(b), bubbles: [b] })),
      ...panelBoxes.flatMap((q, j) => parent[j] === i ? [{ ...box(q), bubbles: readPanel(j) }] : []),
    ];
    return orderBoxes(items, slack, rtl).flatMap(item => item.bubbles);
  };
  return panelBoxes.flatMap((_, i) => parent[i] < 0 ? readPanel(i) : []);
}

const box = ({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 });
const boxArea = b => (b.x1 - b.x0) * (b.y1 - b.y0);
const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
