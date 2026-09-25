// Comic panel detection.
//
// 1. Gutters (the strips between panels) are near-black or near-white straight
//    bands forming a network connected to the page edge. We pick the gutter colour
//    that dominates the page border, keep only pixels of that colour lying on long
//    straight horizontal or vertical runs (so dark shadows in the art don't count),
//    and flood-fill that network inward from the edge.
//    Runs may bridge small breaks (specks, snow, antialiasing), and the flooded
//    network is thickened slightly to seal any remaining pinholes between panels.
// 2. Whatever the flood cannot reach is panel content. Each connected blob of it
//    becomes a candidate panel: its bounding box, ignoring thin slivers that reach
//    out of the main body (so one leak can't stretch a box across a neighbour).
// 3. Fragments of one panel (dark art touching the gutter lets the flood leak in)
//    are irregular shapes lying mostly inside another box; they get merged into it.
//    Solid rectangles inside another box are inset panels and are kept.
// 4. Boxes are put in reading order by recursive XY-cut over the boxes: split into
//    rows where no box straddles the cut, then into columns, and so on.
//
// If that finds no structure, it retries with longer gutter runs (dark artwork can pass
// for gutter), then as a last resort cuts along lines that are mostly gutter (borders
// interrupted by balloons). Pages without a detectable gutter (splash pages, covers)
// return one full-page panel.

const DARK_MAX = 60;             // every channel below this: dark gutter pixel
const LIGHT_MIN = 200;           // every channel above this: light gutter pixel
const MIN_BORDER_GUTTER = 0.08;  // share of border pixels that must be gutter-coloured
const MIN_RETRY_COVERAGE = 0.8;  // retries must find panels covering this much of the page...
const MAX_RETRY_OVERLAP = 0.1;   // ...without overlapping each other by more than this,
const MIN_RETRY_SIDE = 0.15;     // ...and with no sliver panels
const CUT_LINE_SHARE = 0.5;      // fallback cut: share of a line that must lie on gutter runs
const GUTTER_RUNS = [0.1, 0.2, 0.3]; // minimum gutter run lengths to try (fraction of page dimension):
                                     // stricter ones stop gutter-coloured artwork (night skies, black
                                     // clothing) from gluing panels together, but can miss short gutters
const MAX_RUN_BREAK = 4;         // a run may continue across this many off-colour pixels
const SEAL_RADIUS = 2;           // pixels the flooded gutter network is thickened by
const MIN_PANEL_SIDE = 0.06;     // panels narrower/shorter than this fraction of the page are dropped
const MIN_PANEL_AREA = 0.015;    // ...as are panels smaller than this fraction of the page area
const MIN_COVERAGE = 0.35;       // if detected panels cover less of the page than this, treat it as a splash
const SLIVER_SHARE = 0.15;       // rows/columns with less than this share of a blob's widest row/column are slivers
const MIN_SOLID_FILL = 0.8;      // blobs filling at least this much of their box are solid panels (never merged away)
const FRAGMENT_OVERLAP = 0.5;    // a non-solid box this much inside another is a fragment of it
const ORDER_SLACK = 0.03;        // boxes may poke this far (fraction of page) across a reading-order cut

const FULL_PAGE = [{ x: 0, y: 0, w: 1, h: 1 }];

/**
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} image RGBA (or BGRA) pixels
 * @param {{ rtl?: boolean }} options rtl: read columns right-to-left (manga)
 * @returns {{ x: number, y: number, w: number, h: number }[]} panels normalised to 0..1, in reading order
 */
export function detectPanels({ data, width, height }, { rtl = false } = {}) {
  const isGutter = pickGutterTest(data, width, height);
  if (!isGutter) return FULL_PAGE;

  // Start lenient; only if that finds no panel structure, retry with longer gutter runs,
  // and finally cut along lines that are mostly gutter (borders interrupted by balloons)
  // The retries are only trusted when their panels tile the page like a comic page does;
  // on text pages, credits and covers they'd find stray boxes.
  const tiles = (b) => b && b.length > 1 && coverage(b, width, height) >= MIN_RETRY_COVERAGE && !overlapping(b) &&
    b.every(x => x.x1 - x.x0 >= width * MIN_RETRY_SIDE && x.y1 - x.y0 >= height * MIN_RETRY_SIDE);
  let boxes = findPanelBoxes(data, width, height, isGutter, GUTTER_RUNS[0]);
  if (!boxes || boxes.length < 2) {
    boxes = null;
    for (const minRun of GUTTER_RUNS.slice(1)) {
      const found = findPanelBoxes(data, width, height, isGutter, minRun);
      if (tiles(found)) { boxes = found; break; }
    }
    if (!boxes) {
      const cut = cutAlongGutterLines(data, width, height);
      if (tiles(cut)) boxes = cut;
    }
  }
  if (!boxes || boxes.length < 2) return FULL_PAGE;

  const slack = { x: width * ORDER_SLACK, y: height * ORDER_SLACK };
  return orderBoxes(boxes, slack, rtl).map(b => ({
    x: b.x0 / width,
    y: b.y0 / height,
    w: (b.x1 - b.x0) / width,
    h: (b.y1 - b.y0) / height,
  }));
}

// Fallback XY-cut: split the page at lines where most pixels lie on long straight runs of
// gutter colour (dark or light), even though balloons or art interrupt them. Returns the
// resulting panel boxes, or null if the page doesn't split.
function cutAlongGutterLines(data, width, height) {
  const minRun = GUTTER_RUNS[GUTTER_RUNS.length - 1];
  const dark = straightRuns(data, width, height, isDark, minRun);
  const light = straightRuns(data, width, height, isLight, minRun);
  const line = (x, y) => dark[y * width + x] || light[y * width + x];

  // Bands of rows (axis 'y') or columns (axis 'x') inside region r that are mostly gutter line
  const bands = (r, axis) => {
    const [from, to] = axis === 'y' ? [r.y0, r.y1] : [r.x0, r.x1];
    const [across0, across1] = axis === 'y' ? [r.x0, r.x1] : [r.y0, r.y1];
    const result = [];
    let start = -1;
    for (let k = from; k <= to; k++) {
      let on = false;
      if (k < to) {
        let n = 0;
        for (let a = across0; a < across1; a++) if (axis === 'y' ? line(a, k) : line(k, a)) n++;
        on = n >= (across1 - across0) * CUT_LINE_SHARE;
      }
      if (on && start < 0) start = k;
      if (!on && start >= 0) { result.push([start, k]); start = -1; }
    }
    return result;
  };

  const leaves = [];
  const cut = (r, depth) => {
    // Trim gutter bands off the region's edges
    for (const axis of ['y', 'x']) {
      const lo = axis === 'y' ? 'y0' : 'x0', hi = axis === 'y' ? 'y1' : 'x1';
      for (const [a, b] of bands(r, axis)) {
        if (a <= r[lo]) r[lo] = b;
        else if (b >= r[hi]) r[hi] = a;
      }
    }
    if (r.x1 - r.x0 < width * MIN_PANEL_SIDE || r.y1 - r.y0 < height * MIN_PANEL_SIDE) return;
    if (depth < 6) {
      for (const axis of ['y', 'x']) {
        const lo = axis === 'y' ? 'y0' : 'x0', hi = axis === 'y' ? 'y1' : 'x1';
        const minSide = (axis === 'y' ? height : width) * MIN_PANEL_SIDE;
        const inner = bands(r, axis).filter(([a, b]) => a - r[lo] >= minSide && r[hi] - b >= minSide);
        if (inner.length > 0) {
          let prev = r[lo];
          for (const [a, b] of inner) {
            cut({ ...r, [lo]: prev, [hi]: a }, depth + 1);
            prev = b;
          }
          cut({ ...r, [lo]: prev }, depth + 1);
          return;
        }
      }
    }
    leaves.push(r);
  };
  cut({ x0: 0, y0: 0, x1: width, y1: height }, 0);

  const panels = leaves.filter(b => (b.x1 - b.x0) * (b.y1 - b.y0) >= width * height * MIN_PANEL_AREA);
  return panels.length > 1 ? panels : null;
}

// Do any two boxes overlap by more than a sliver (real panels sit side by side)?
function overlapping(boxes) {
  return boxes.some((a, i) => boxes.some((b, j) => {
    if (j <= i) return false;
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const smaller = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
    return w > 0 && h > 0 && w * h > smaller * MAX_RETRY_OVERLAP;
  }));
}

// Share of the page covered by the union of boxes (sampled on a coarse grid)
function coverage(boxes, width, height) {
  const STEP = 4;
  let hit = 0, total = 0;
  for (let y = STEP / 2; y < height; y += STEP) {
    for (let x = STEP / 2; x < width; x += STEP) {
      total++;
      if (boxes.some(b => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1)) hit++;
    }
  }
  return hit / total;
}

// Panel boxes (pixels) for one gutter run length, or null if they cover too little of the page
function findPanelBoxes(data, width, height, isGutter, minRun) {
  const gutters = straightRuns(data, width, height, isGutter, minRun);
  const flooded = dilate(floodGutters(gutters, width, height), width, height, SEAL_RADIUS);
  let boxes = contentBoxes(flooded, width, height)
    .filter(b =>
      b.x1 - b.x0 >= width * MIN_PANEL_SIDE &&
      b.y1 - b.y0 >= height * MIN_PANEL_SIDE &&
      (b.x1 - b.x0) * (b.y1 - b.y0) >= width * height * MIN_PANEL_AREA);
  boxes = mergeFragments(boxes).map(b => ({
    x0: Math.max(0, b.x0 - SEAL_RADIUS), y0: Math.max(0, b.y0 - SEAL_RADIUS),
    x1: Math.min(width, b.x1 + SEAL_RADIUS), y1: Math.min(height, b.y1 + SEAL_RADIUS),
  }));

  const covered = boxes.reduce((sum, b) => sum + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
  return boxes.length === 0 || covered < width * height * MIN_COVERAGE ? null : boxes;
}

const isDark = (d, p) => d[p] < DARK_MAX && d[p + 1] < DARK_MAX && d[p + 2] < DARK_MAX;
const isLight = (d, p) => d[p] > LIGHT_MIN && d[p + 1] > LIGHT_MIN && d[p + 2] > LIGHT_MIN;

// Choose dark or light gutters by which is more common around the page edge
function pickGutterTest(data, width, height) {
  let dark = 0, light = 0, total = 0;
  const sample = (x, y) => {
    const p = (y * width + x) * 4;
    if (isDark(data, p)) dark++;
    else if (isLight(data, p)) light++;
    total++;
  };
  for (let x = 0; x < width; x++) { sample(x, 0); sample(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { sample(0, y); sample(width - 1, y); }

  const best = Math.max(dark, light);
  if (best < total * MIN_BORDER_GUTTER) return null;
  return dark >= light ? isDark : isLight;
}

// Gutter-coloured pixels that lie on a long horizontal or vertical run of gutter colour
function straightRuns(data, width, height, isGutter, minRun) {
  const colored = new Uint8Array(width * height);
  for (let i = 0; i < colored.length; i++) colored[i] = isGutter(data, i * 4) ? 1 : 0;

  const runs = new Uint8Array(width * height);

  // Scan one line (n pixels, index = base + k * stride) for long runs, bridging short breaks
  const scan = (base, stride, n, minLen) => {
    for (let k = 0; k < n;) {
      if (!colored[base + k * stride]) { k++; continue; }
      const start = k;
      let end = k + 1; // exclusive end of the run's last coloured pixel
      for (let j = k + 1; j < n && j - end <= MAX_RUN_BREAK; j++) {
        if (colored[base + j * stride]) end = j + 1;
      }
      if (end - start >= minLen) {
        for (let j = start; j < end; j++) runs[base + j * stride] = 1;
      }
      k = end;
    }
  };
  for (let y = 0; y < height; y++) scan(y * width, 1, width, width * minRun);
  for (let x = 0; x < width; x++) scan(x, width, height, height * minRun);
  return runs;
}

// Grow a mask by `radius` pixels in every direction (separable square max filter)
export function dilate(mask, width, height, radius) {
  const horiz = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      horiz.fill(1, row + Math.max(0, x - radius), row + Math.min(width, x + radius + 1));
    }
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (!horiz[i]) continue;
    const x = i % width, y = (i - x) / width;
    for (let k = Math.max(0, y - radius); k <= Math.min(height - 1, y + radius); k++) out[k * width + x] = 1;
  }
  return out;
}

// Flood-fill the gutter network reachable from the page edge (4-connected)
function floodGutters(gutters, width, height) {
  const flooded = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;

  const push = (i) => {
    if (!flooded[i] && gutters[i]) {
      flooded[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { push(y * width); push(y * width + width - 1); }

  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < width * (height - 1)) push(i + width);
  }
  return flooded;
}

// Boxes of connected non-gutter regions, each with `fill` (share of its box it covers)
function contentBoxes(flooded, width, height) {
  const labels = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  const blobs = [];

  for (let start = 0; start < labels.length; start++) {
    if (flooded[start] || labels[start] >= 0) continue;
    const id = blobs.length;
    labels[start] = id;
    let head = 0, tail = 0;
    queue[tail++] = start;
    const blob = { id, x0: width, y0: height, x1: 0, y1: 0 };

    while (head < tail) {
      const i = queue[head++];
      const x = i % width, y = (i - x) / width;
      if (x < blob.x0) blob.x0 = x;
      if (x >= blob.x1) blob.x1 = x + 1;
      if (y < blob.y0) blob.y0 = y;
      if (y >= blob.y1) blob.y1 = y + 1;
      const visit = (j) => {
        if (!flooded[j] && labels[j] < 0) { labels[j] = id; queue[tail++] = j; }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y < height - 1) visit(i + width);
    }
    blobs.push(blob);
  }

  // Tighten each box to the rows/columns where the blob has real presence
  const minSide = Math.min(width, height) * MIN_PANEL_SIDE;
  return blobs
    .filter(b => b.x1 - b.x0 >= minSide && b.y1 - b.y0 >= minSide)
    .map(b => {
      const rows = new Uint32Array(b.y1 - b.y0);
      const cols = new Uint32Array(b.x1 - b.x0);
      for (let y = b.y0; y < b.y1; y++) {
        for (let x = b.x0; x < b.x1; x++) {
          if (labels[y * width + x] === b.id) { rows[y - b.y0]++; cols[x - b.x0]++; }
        }
      }
      const [top, bottom] = solidSpan(rows);
      const [left, right] = solidSpan(cols);
      const box = { x0: b.x0 + left, y0: b.y0 + top, x1: b.x0 + right, y1: b.y0 + bottom };

      let count = 0;
      for (let y = box.y0; y < box.y1; y++) {
        for (let x = box.x0; x < box.x1; x++) if (labels[y * width + x] === b.id) count++;
      }
      box.fill = count / ((box.x1 - box.x0) * (box.y1 - box.y0));
      return box;
    });
}

// [start, end) of the histogram range whose values reach SLIVER_SHARE of its peak
function solidSpan(hist) {
  let peak = 0;
  for (const v of hist) if (v > peak) peak = v;
  const min = peak * SLIVER_SHARE;
  let start = 0, end = hist.length;
  while (start < end && hist[start] < min) start++;
  while (end > start && hist[end - 1] < min) end--;
  return [start, end];
}

const area = b => (b.x1 - b.x0) * (b.y1 - b.y0);
const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

// Fold irregular fragments into the box they mostly lie inside
function mergeFragments(boxes) {
  const result = [...boxes].sort((a, b) => area(b) - area(a));
  for (let i = result.length - 1; i >= 0; i--) {
    const frag = result[i];
    if (frag.fill >= MIN_SOLID_FILL) continue;
    const host = result.find((b, j) => j !== i && area(b) >= area(frag) &&
      overlapArea(frag, b) >= area(frag) * FRAGMENT_OVERLAP);
    if (!host) continue;
    host.x0 = Math.min(host.x0, frag.x0);
    host.y0 = Math.min(host.y0, frag.y0);
    host.x1 = Math.max(host.x1, frag.x1);
    host.y1 = Math.max(host.y1, frag.y1);
    result.splice(i, 1);
  }
  return result;
}

// Recursive XY-cut over boxes ({x0, y0, x1, y1}): rows top-to-bottom, then columns
// left-to-right (or right-to-left). `slack` ({x, y} px) lets boxes poke across a cut.
export function orderBoxes(boxes, slack, rtl) {
  if (boxes.length <= 1) return boxes;

  const rows = groupAlong(boxes, 'y', slack.y);
  if (rows.length > 1) return rows.flatMap(group => orderBoxes(group, slack, rtl));

  const cols = groupAlong(boxes, 'x', slack.x);
  if (cols.length > 1) {
    if (rtl) cols.reverse();
    return cols.flatMap(group => orderBoxes(group, slack, rtl));
  }

  // No clean cut: fall back to top-then-left ordering
  return [...boxes].sort((a, b) => (a.y0 - b.y0) || (rtl ? b.x1 - a.x1 : a.x0 - b.x0));
}

// Partition boxes into bands along an axis, cutting wherever no (slack-shrunk) box spans the cut
function groupAlong(boxes, axis, slack) {
  const lo = axis === 'y' ? 'y0' : 'x0';
  const hi = axis === 'y' ? 'y1' : 'x1';
  const sorted = [...boxes].sort((a, b) => a[lo] - b[lo]);
  const groups = [];
  let current = [];
  let reach = -Infinity;

  for (const b of sorted) {
    if (current.length > 0 && b[lo] + slack >= reach) {
      groups.push(current);
      current = [];
      reach = -Infinity;
    }
    current.push(b);
    reach = Math.max(reach, b[hi] - slack);
  }
  groups.push(current);
  return groups;
}

