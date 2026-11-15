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
//    A box crossed by a thin straight band of flooded gutter is split along it: panels
//    joined through an overlapping inset (whose frame isn't gutter-coloured) come apart.
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
const MAX_RUN_BREAK = 4;         // a run may continue across this many off-colour pixels,
const MAX_SPECK_BREAK = 10;      // ...or this many between solid pieces of line
const MIN_SPECK_SIDE = 20;       // ...at least this long on both sides (a speck on a frame line)
const SPECK_SIDE_FILL = 0.9;     // ...and this solid (as a thin line)
const SEAL_RADIUS = 2;           // pixels the flooded gutter network is thickened by
const MIN_PANEL_SIDE = 0.06;     // panels narrower/shorter than this fraction of the page are dropped
const MIN_PANEL_AREA = 0.015;    // ...as are panels smaller than this fraction of the page area
const MIN_COVERAGE = 0.35;       // if detected panels cover less of the page than this, treat it as a splash
const SLIVER_SHARE = 0.15;       // rows/columns with less than this share of a blob's widest row/column are slivers
const MIN_SOLID_FILL = 0.8;      // blobs filling at least this much of their box are solid panels (never merged away)
const FRAGMENT_OVERLAP = 0.5;    // a non-solid box this much inside another is a fragment of it
const SPLIT_LINE_SHARE = 0.5;    // a line across a box this much flooded gutter splits it...
const MIN_SPLIT_SIDE = 0.1;      // ...into pieces at least this big (fraction of page),
const MAX_SPLIT_GUTTER = 0.03;   // ...if the band is at most this thick (fraction of page)
const SPLIT_MARGIN = 4;          // ...and lines this many pixels beyond it on both sides
const SPLIT_OUTSIDE_SHARE = 0.1; // ...are at most this much flooded
const SPLIT_OUTSIDE_COLOR = 0.3; // ...and this much gutter-coloured,
const SPLIT_COLOR_JUMP = 0.3;    // ...while the band's core is gutter-coloured by this much more
const MIN_FRAME_SIDE = 0.12;     // inset frames: sides at least this long (fraction of page)...
const FRAME_COVER = 0.85;        // ...each this much dark (every channel below FRAME_DARK_MAX)...
const FRAME_DARK_MAX = 100;
const FRAME_LINE_COVER = 0.5;    // ...and this much a thin dark line (dark, with a lighter pixel
const FRAME_LINE_WIDTH = 3;      // ...this far to one side across it)...
const FRAME_EDGE_OFFSET = 5;     // ...with this far to one side of it...
const FRAME_SIDE_DARK = 0.5;     // ...at most this much dark
const FRAME_CORNER_GAP = 20;     // a side may lie this many pixels beyond the ends of the top/bottom lines
const FRAME_GROUP_SHARE = 0.2;   // a frame around several solid panels this big (share of it) frames a group
const FRAME_CROSS_MARGIN = 0.1;  // ...or with a gutter line across it, further than this (share of its side) inside
const CORNER_TOLERANCE = 0.03;   // a box this close (fraction of page) to two sides of a bigger one sits in its corner
const CORNER_LINE_SHARE = 0.5;   // the bigger one is cut beside it along a line this much gutter (or gutter-coloured)
const STRIP_LINE = 0.85;         // a row this much gutter-coloured right across the page divides strips...
const STRIP_SIDE = 0.6;          // ...if at least one side of the band is at most this much
const STRIP_OVERLAP = 0.02;      // ...or that overlap by at least this (fraction of page width)
const STRIP_EATEN_FILL = 0.65;   // ...or that meet edge to edge, one filling at most this much of its box
const STRIP_RAGGED_MIN = 0.2;    // ...or that span the same rows and face each other across a gap with both edges
const STRIP_RAGGED_EDGE = 0.65;  // ...between these fills (cut raggedly through artwork: a gutter leaves an edge full or empty)
const STRIP_TALL = 0.6;          // pieces at least this share of a strip's height that touch (or any that overlap) are one panel
const ORDER_SLACK = 0.03;      // boxes may poke this far (fraction of page) across a reading-order cut
const EDGE_DEPTH = 0.03;         // leak check: compare a box edge's content with this far (fraction of page) inside
const LEAK_EDGE_FILL = 0.3;      // an edge this empty...
const LEAK_FILL_JUMP = 0.4;      // ...while fuller inside by this much was eaten by a leak (ragged), not cut by a gutter
const SEAM_EDGE_FILL = 0.5;      // across a leak both edges are this empty (a gutter leaves at least one edge full)
const MAX_SEAM_GAP = 0.08;       // boxes this close (fraction of page) across a ragged edge are one panel...
const MIN_SEAM_GAP = 0.005;      // ...but not closer: boxes almost touching are framed panels side by side
const MAX_MERGE_INTRUSION = 0.1; // a merge may cover at most this share of any other box
const THIN_BOX = 0.12;           // a box this thin (fraction of page) torn off a neighbour may touch it
const GUTTER_LINE = 0.95;        // a leaky edge moves outward until a line this much gutter-coloured (the gutter)...
const MAX_EXPAND = 0.4;          // ...within this far (fraction of page); further means it isn't one panel

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
  // Inset panels framed by a thin line over another panel's art aren't reached by the
  // flood (or only partly, through gaps in the frame): wall their frames off explicitly
  // (On light-gutter pages every panel is framed, and frames around groups of panels abound.)
  const frames = isGutter === isDark ? findFrames(data, width, height) : [];
  const walled = frames.length > 0 ? wallFrames(flooded, frames, width, height) : flooded;
  let boxes = contentBoxes(walled, width, height)
    .filter(b =>
      b.x1 - b.x0 >= width * MIN_PANEL_SIDE &&
      b.y1 - b.y0 >= height * MIN_PANEL_SIDE &&
      (b.x1 - b.x0) * (b.y1 - b.y0) >= width * height * MIN_PANEL_AREA)
    .flatMap(b => splitAlongGutters(b, flooded, width, height, (i) => isGutter(data, i * 4)));
  boxes = claimFrames(boxes, frames, width, (i) => isGutter(data, i * 4));
  boxes = mergeFragments(boxes);
  // Dark gutters leak into dark artwork (hair, shadows, night scenes) along its edges
  if (isGutter === isDark) boxes = repairLeaks(boxes, walled, width, height, (i) => isGutter(data, i * 4));
  boxes = splitAroundCorners(boxes, walled, width, height, (i) => isGutter(data, i * 4));
  if (isGutter === isDark) boxes = joinStrips(boxes, walled, width, height, (i) => isGutter(data, i * 4));
  boxes = boxes.map(b => ({
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

  // Scan one line (n pixels, index = base + k * stride) for long runs, bridging short breaks.
  // Pieces of solid line on both sides of a longer break (a snow speck on a frame line) are
  // joined too; dotted or speckled artwork doesn't have such pieces.
  const scan = (base, stride, n, minLen, across) => {
    // A solid stretch [from, to) of thin line: coloured with an off-colour pixel close by
    // across the line (lettering makes long pieces too, but full of gaps; gutter-coloured
    // artwork makes solid ones, but not thin)
    const d = FRAME_LINE_WIDTH * across;
    const solidLine = (from, to) => {
      if (from < 0 || to > n) return false;
      let count = 0;
      for (let j = from; j < to; j++) {
        const i = base + j * stride;
        if (colored[i] && (i - d < 0 || i + d >= colored.length || !colored[i - d] || !colored[i + d])) count++;
      }
      return count >= (to - from) * SPECK_SIDE_FILL;
    };
    let runStart = -1, runEnd = -1;
    const flush = () => {
      if (runStart >= 0 && runEnd - runStart >= minLen) {
        for (let j = runStart; j < runEnd; j++) runs[base + j * stride] = 1;
      }
    };
    for (let k = 0; k < n;) {
      if (!colored[base + k * stride]) { k++; continue; }
      const start = k;
      let end = k + 1; // exclusive end of the piece's last coloured pixel
      for (let j = k + 1; j < n && j - end <= MAX_RUN_BREAK; j++) {
        if (colored[base + j * stride]) end = j + 1;
      }
      if (runStart >= 0 && start - runEnd <= MAX_SPECK_BREAK &&
          solidLine(runEnd - MIN_SPECK_SIDE, runEnd) && solidLine(start, start + MIN_SPECK_SIDE)) {
        runEnd = end;
      } else {
        flush();
        runStart = start;
        runEnd = end;
      }
      k = end;
    }
    flush();
  };
  for (let y = 0; y < height; y++) scan(y * width, 1, width, width * minRun, width);
  for (let x = 0; x < width; x++) scan(x, width, height, height * minRun, 1);
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

// Rectangles ({x0, y0, x1, y1}, the frame line's position) whose four sides are mostly thin
// dark lines: panel frames, wherever they are drawn. Corners may be broken (a frame fades
// where it crosses equally dark art), so each side only needs FRAME_COVER of its length.
function findFrames(data, width, height) {
  const n = width * height;
  const dark = new Uint8Array(n);
  // Frames are often drawn in a dark colour (navy, brown) rather than black
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    dark[i] = data[p] < FRAME_DARK_MAX && data[p + 1] < FRAME_DARK_MAX && data[p + 2] < FRAME_DARK_MAX ? 1 : 0;
  }
  // Line pixels: dark with lighter pixels close by on at least one side across the line
  // (so the inside of a dark area isn't a line, only its edge). Thickened by a pixel along
  // the other axis so a line wobbling between two rows/columns still counts as straight.
  const d = FRAME_LINE_WIDTH;
  const rowLine = new Uint8Array(n), colLine = new Uint8Array(n);
  for (let y = d; y < height - d; y++) {
    for (let x = d; x < width - d; x++) {
      const i = y * width + x;
      if (!dark[i]) continue;
      if (!dark[i - d * width] || !dark[i + d * width]) rowLine[i - width] = rowLine[i] = rowLine[i + width] = 1;
      if (!dark[i - d] || !dark[i + d]) colLine[i - 1] = colLine[i] = colLine[i + 1] = 1;
    }
  }
  // Prefix sums along rows (index y * (width + 1) + x: pixels in row y left of x) and down
  // columns (index y * width + x: pixels in column x above y)
  const alongRows = (mask) => {
    const sum = new Int32Array(height * (width + 1));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) sum[y * (width + 1) + x + 1] = sum[y * (width + 1) + x] + mask[y * width + x];
    }
    return (y, x0, x1) => (sum[y * (width + 1) + x1] - sum[y * (width + 1) + x0]) / (x1 - x0);
  };
  const downCols = (mask) => {
    const sum = new Int32Array((height + 1) * width);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) sum[(y + 1) * width + x] = sum[y * width + x] + mask[y * width + x];
    }
    return (x, y0, y1) => (sum[y1 * width + x] - sum[y0 * width + x]) / (y1 - y0);
  };
  const rowLineCover = alongRows(rowLine), rowRawDark = alongRows(dark);
  const colLineCover = downCols(colLine), colRawDark = downCols(dark);
  // A frame side is dark nearly all along; where artwork as dark as the frame touches it,
  // it's no longer a thin line, so only part of it needs to be one. And it's an edge: on one
  // side of it there's lighter artwork (rows inside dark hatching are dark on both sides).
  const o = FRAME_EDGE_OFFSET;
  // (The darkness is measured on the darkest single row/column of the three, as a line is
  // solid along one of them: hatching is dark only when neighbouring rows are combined.)
  const rowCover = (y, x0, x1) =>
    y - o >= 0 && y + o < height && rowLineCover(y, x0, x1) >= FRAME_LINE_COVER &&
    Math.min(rowRawDark(y - o, x0, x1), rowRawDark(y + o, x0, x1)) <= FRAME_SIDE_DARK
      ? Math.max(rowRawDark(y - 1, x0, x1), rowRawDark(y, x0, x1), rowRawDark(y + 1, x0, x1)) : 0;
  const colCover = (x, y0, y1) =>
    x - o >= 0 && x + o < width && colLineCover(x, y0, y1) >= FRAME_LINE_COVER &&
    Math.min(colRawDark(x - o, y0, y1), colRawDark(x + o, y0, y1)) <= FRAME_SIDE_DARK
      ? Math.max(colRawDark(x - 1, y0, y1), colRawDark(x, y0, y1), colRawDark(x + 1, y0, y1)) : 0;

  // Candidate sides: long stretches of line pixels along rows (top/bottom) or columns
  // (left/right), one per line, not one per row of a thickened line. `at` is the line's
  // position, [from, to) its extent.
  const segments = (lineMask, horizontal) => {
    const [along, across] = horizontal ? [width, height] : [height, width];
    const step = horizontal ? 1 : width; // pixel step along the line
    const result = [];
    const minLen = Math.round(along * MIN_FRAME_SIDE);
    for (let at = 0; at < across; at++) {
      const base = horizontal ? at * width : at;
      for (let k = 0; k < along;) {
        if (!lineMask[base + k * step]) { k++; continue; }
        let end = k + 1;
        for (let j = k + 1; j < along && j - end <= MAX_RUN_BREAK; j++) if (lineMask[base + j * step]) end = j + 1;
        if (end - k >= minLen && !result.some(s => at - s.at <= 2 && s.from < end && k < s.to)) {
          result.push({ at: at + 1, from: k, to: end }); // middle of the thickened line
        }
        k = end;
      }
    }
    return result;
  };

  // Frames from a pair of opposite sides (`a` before `b` across the lines). The other two
  // sides are the nearest frame-like lines crossing between them, searched outward from the
  // ends of the shorter one (the longer one may be the edge of a gutter running on past the
  // frame; either may stop short of a corner where dark artwork touches the frame).
  // `sideCover(k, a, b)` measures a crossing line at k, `ownCover(at, from, to)` one of the pair.
  const frames = [];
  const pairUp = (lines, alongSize, acrossSize, sideCover, ownCover, toFrame) => {
    const minGap = Math.round(acrossSize * MIN_FRAME_SIDE), minLen = Math.round(alongSize * MIN_FRAME_SIDE);
    for (const a of lines) {
      for (const b of lines) {
        if (b.at - a.at < minGap) continue;
        const short = a.to - a.from <= b.to - b.from ? a : b;
        let lo = -1;
        for (let k = Math.min(alongSize - 1, short.from + FRAME_CORNER_GAP); k >= 0 && lo < 0; k--) {
          if (sideCover(k, a.at, b.at) >= FRAME_COVER) lo = k;
        }
        if (lo < 0) continue;
        let hi = -1;
        for (let k = Math.max(lo + minLen, short.to - 1 - FRAME_CORNER_GAP); k < alongSize && hi < 0; k++) {
          if (sideCover(k, a.at, b.at) >= FRAME_COVER && ownCover(a.at, lo, k) >= FRAME_COVER &&
              ownCover(b.at, lo, k) >= FRAME_COVER) hi = k;
        }
        if (hi < 0 || ownCover(a.at, lo, hi) < FRAME_COVER || ownCover(b.at, lo, hi) < FRAME_COVER) continue;
        const frame = toFrame(a.at, b.at, lo, hi);
        if (!frames.some(f => overlapArea(f, frame) >= Math.max(area(f), area(frame)) * 0.9)) frames.push(frame);
      }
    }
  };
  // From top and bottom (sides are columns), and from left and right (sides are rows), so a
  // frame is found even when one pair of its sides blends into a dark margin
  pairUp(segments(rowLine, true), width, height, colCover, rowCover,
    (y0, y1, x0, x1) => ({ x0, y0, x1, y1 }));
  pairUp(segments(colLine, false), height, width, rowCover, colCover,
    (x0, x1, y0, y1) => ({ x0, y0, x1, y1 }));
  return frames;
}

// Copy of the flooded mask with the frames' outlines added as gutter
function wallFrames(flooded, frames, width, height) {
  const walled = flooded.slice();
  const t = SEAL_RADIUS;
  const fill = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) {
      walled.fill(1, y * width + Math.max(0, x0), y * width + Math.min(width - 1, x1) + 1);
    }
  };
  for (const f of frames) {
    fill(f.x0 - t, f.y0 - t, f.x1 + t, f.y0 + t);
    fill(f.x0 - t, f.y1 - t, f.x1 + t, f.y1 + t);
    fill(f.x0 - t, f.y0 - t, f.x0 + t, f.y1 + t);
    fill(f.x1 - t, f.y0 - t, f.x1 + t, f.y1 + t);
  }
  return walled;
}

// Replace the boxes inside each frame (pieces of the framed panel: the flood may have
// leaked into its dark areas) with the frame's inside, marked as an inset so that it is
// never merged into the panel around it. A frame around a group of panels (several solid
// panels inside, or a gutter-coloured line straight across) is left alone.
function claimFrames(boxes, frames, width, isGutterAt) {
  // Is some row or column well inside the frame gutter-coloured (all but a few pixels)
  // across the boxes inside it?
  const crossed = (f, inside) => {
    const x0 = Math.min(...inside.map(b => b.x0)), x1 = Math.max(...inside.map(b => b.x1));
    const y0 = Math.min(...inside.map(b => b.y0)), y1 = Math.max(...inside.map(b => b.y1));
    const margin = Math.round(Math.min(f.x1 - f.x0, f.y1 - f.y0) * FRAME_CROSS_MARGIN);
    for (let y = f.y0 + margin; y < f.y1 - margin; y++) {
      let n = 0;
      for (let x = x0; x < x1; x++) if (isGutterAt(y * width + x)) n++;
      if (n >= (x1 - x0) * GUTTER_LINE) return true;
    }
    for (let x = f.x0 + margin; x < f.x1 - margin; x++) {
      let n = 0;
      for (let y = y0; y < y1; y++) if (isGutterAt(y * width + x)) n++;
      if (n >= (y1 - y0) * GUTTER_LINE) return true;
    }
    return false;
  };
  let result = boxes;
  for (const f of [...frames].sort((a, b) => area(a) - area(b))) {
    const inside = result.filter(b => overlapArea(b, f) >= area(b) * 0.9);
    const solid = inside.filter(b => b.fill >= MIN_SOLID_FILL && area(b) >= area(f) * FRAME_GROUP_SHARE);
    if (inside.length === 0 || solid.length > 1 || crossed(f, inside)) continue;
    const t = SEAL_RADIUS + 1;
    const panel = { x0: f.x0 + t, y0: f.y0 + t, x1: f.x1 - t, y1: f.y1 - t, fill: 1, inset: true };
    result = [...result.filter(b => !inside.includes(b)), panel];
  }
  return result;
}

// A box wrapped around another box sitting in one of its corners is an L-shaped blob:
// panels joined around the corner box where a gap in the border between them let the
// gutter flood through. Cut off the L's arm beside the corner box, along a line (gutter, or
// a gutter-coloured border with gaps) continuing the corner box's edge. Without such a
// line it's a panel with an inset in its corner, and stays whole.
function splitAroundCorners(boxes, flooded, width, height, isGutterAt) {
  const tol = { x: Math.round(width * CORNER_TOLERANCE), y: Math.round(height * CORNER_TOLERANCE) };
  const lineShare = (x0, y0, x1, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (flooded[y * width + x] || isGutterAt(y * width + x)) n++;
    return n / Math.max(1, (x1 - x0) * (y1 - y0));
  };
  // The line along k (rows for axis 'y') within tol of `at`, across [from, to), most like a border
  const findLine = (axis, at, from, to) => {
    let best = -1, share = CORNER_LINE_SHARE;
    for (let k = at - tol[axis]; k <= at + tol[axis]; k++) {
      if (k < 0 || k >= (axis === 'y' ? height : width)) continue;
      const v = axis === 'y' ? lineShare(from, k, to, k + 1) : lineShare(k, from, k + 1, to);
      if (v >= share) { best = k; share = v; }
    }
    return best;
  };
  const cut = (a, b) => {
    const near = (p, q, axis) => Math.abs(p - q) <= tol[axis];
    const vSide = near(a.y0, b.y0, 'y') ? 'top' : near(a.y1, b.y1, 'y') ? 'bottom' : null;
    const hSide = near(a.x0, b.x0, 'x') ? 'left' : near(a.x1, b.x1, 'x') ? 'right' : null;
    if (!vSide || !hSide || near(a.x1 - a.x0, b.x1 - b.x0, 'x') || near(a.y1 - a.y0, b.y1 - b.y0, 'y')) return null;
    // Arm beside the corner box, cut off along a row continuing its inner edge
    const [ax0, ax1] = hSide === 'left' ? [a.x1, b.x1] : [b.x0, a.x0];
    const k = findLine('y', vSide === 'top' ? a.y1 : a.y0, ax0, ax1);
    if (k < 0) return null;
    const arm = vSide === 'top' ? { x0: ax0, y0: b.y0, x1: ax1, y1: k } : { x0: ax0, y0: k + 1, x1: ax1, y1: b.y1 };
    const rest = vSide === 'top' ? { x0: b.x0, y0: k + 1, x1: b.x1, y1: b.y1 } : { x0: b.x0, y0: b.y0, x1: b.x1, y1: k };
    const big = (r) => r.x1 - r.x0 >= width * MIN_SPLIT_SIDE && r.y1 - r.y0 >= height * MIN_SPLIT_SIDE;
    if (!big(arm) || !big(rest)) return null;
    return [{ ...arm, fill: b.fill, cut: true }, { ...rest, fill: b.fill, cut: true }];
  };
  let result = [...boxes];
  for (let changed = true; changed;) {
    changed = false;
    for (const a of result) {
      if (a.inset) continue;
      const b = result.find(b => b !== a && area(b) > area(a) && overlapArea(a, b) >= area(a) * 0.9);
      const pieces = b && cut(a, b);
      if (!pieces) continue;
      result = [...result.filter(x => x !== b), ...pieces];
      changed = true;
      break;
    }
  }
  return result;
}

// Pages built from full-width (or full-height) strips: where dark artwork touches the
// gutters the flood eats into panels, leaving pieces of one panel that overlap, touch, or
// face each other across a ragged gap (real panels side by side have a gutter between them,
// which leaves straight full edges). Find the strips' dividing gutter bands (lines almost
// all gutter-coloured right across the page), split boxes crossing one, and within each
// strip merge such pieces. Insets and boxes cut beside a corner box are kept.
function joinStrips(boxes, flooded, width, height, isGutterAt) {
  const rows = joinStripsAlongRows(boxes, flooded, width, height, isGutterAt, true);
  // Columns: the same on the transposed page, but only merging (dark artwork running down a
  // page passes for a gutter band more easily than across it)
  const n = width * height;
  const tFlooded = new Uint8Array(n), tGutter = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tFlooded[x * height + y] = flooded[y * width + x];
      tGutter[x * height + y] = isGutterAt(y * width + x) ? 1 : 0;
    }
  }
  const flip = (b) => ({ ...b, x0: b.y0, y0: b.x0, x1: b.y1, y1: b.x1 });
  return joinStripsAlongRows(rows.map(flip), tFlooded, height, width, (i) => tGutter[i], false).map(flip);
}

function joinStripsAlongRows(boxes, flooded, width, height, isGutterAt, split) {
  const rowShare = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x++) if (isGutterAt(y * width + x)) n++;
    rowShare[y] = n / width;
  }
  const margin = Math.round(height * MIN_PANEL_SIDE);
  const bands = [];
  for (let y = margin; y < height - margin;) {
    if (rowShare[y] < STRIP_LINE) { y++; continue; }
    let end = y + 1;
    while (end < height && rowShare[end] >= STRIP_LINE) end++;
    const clean = Math.min(rowShare[Math.max(0, y - SPLIT_MARGIN)], rowShare[Math.min(height - 1, end - 1 + SPLIT_MARGIN)]) <= STRIP_SIDE;
    if (end - y <= height * MAX_SPLIT_GUTTER && clean && end <= height - margin) bands.push([y, end]);
    y = end;
  }
  if (bands.length === 0) return boxes;

  // Split boxes across bands
  let result = boxes.flatMap(b => {
    if (b.inset || !split) return [b];
    const pieces = [];
    let from = b.y0;
    for (const [y0, y1] of bands) {
      if (y0 - from >= height * MIN_SPLIT_SIDE && b.y1 - y1 >= height * MIN_SPLIT_SIDE) {
        pieces.push({ ...b, y0: from, y1: y0 });
        from = y1;
      }
    }
    return pieces.length ? [...pieces, { ...b, y0: from }] : [b];
  });

  // Merge touching tall pieces within each strip
  const edges = [0, ...bands.flat(), height];
  for (let k = 0; k < edges.length; k += 2) {
    const [s0, s1] = [edges[k], edges[k + 1]];
    const inStrip = (b) => !b.inset && !b.cut && b.y0 >= s0 - SPLIT_MARGIN && b.y1 <= s1 + SPLIT_MARGIN;
    const tall = (b) => b.y1 - b.y0 >= (s1 - s0) * STRIP_TALL;
    // Tall pieces touching side by side, or any pieces overlapping
    // ...unless the flood found a gutter running down the strip between them: a thin band of
    // columns mostly flooded, with little flood just beside it (a leak is a wide ragged blob)
    const colShare = (x, y0, y1) => {
      let n = 0;
      for (let y = y0; y < y1; y++) if (flooded[y * width + x]) n++;
      return n / Math.max(1, y1 - y0);
    };
    const gutterBetween = (a, c) => {
      const y0 = Math.max(a.y0, c.y0), y1 = Math.min(a.y1, c.y1);
      if (y1 <= y0) return false;
      const from = Math.min(a.x0, c.x0) + SPLIT_MARGIN, to = Math.max(a.x1, c.x1) - SPLIT_MARGIN;
      for (let x = from; x < to;) {
        if (colShare(x, y0, y1) < SPLIT_LINE_SHARE) { x++; continue; }
        let end = x + 1;
        while (end < to && colShare(end, y0, y1) >= SPLIT_LINE_SHARE) end++;
        const side = Math.max(colShare(x - SPLIT_MARGIN, y0, y1), colShare(end - 1 + SPLIT_MARGIN, y0, y1));
        if (end - x <= width * MAX_SPLIT_GUTTER && side <= SPLIT_OUTSIDE_SHARE) return true;
        x = end;
      }
      return false;
    };
    // Pieces bitten apart by a leak overlap clearly, meet edge to edge beside a badly eaten
    // piece, or (spanning the same rows) face each other across a gap with both edges ragged; panels split by a gutter leave
    // straight full edges, overlapping by a few pixels at most. A box mostly inside the other
    // is an inset, not a piece of it.
    // Share of a column's pixels (over the rows both boxes share) that is content, not flood
    const colFill = (x, a, c) => 1 - colShare(x, Math.max(a.y0, c.y0), Math.min(a.y1, c.y1));
    const joined = (a, c) => {
      const gap = Math.max(a.x0, c.x0) - Math.min(a.x1, c.x1);
      const overlapping = -gap >= width * STRIP_OVERLAP && overlapArea(a, c) > 0;
      const meeting = gap >= -1 && gap <= width * MIN_SEAM_GAP && tall(a) && tall(c) &&
        Math.min(a.fill, c.fill) <= STRIP_EATEN_FILL;
      const [l, r] = a.x0 <= c.x0 ? [a, c] : [c, a];
      const aligned = Math.abs(a.y0 - c.y0) <= SPLIT_MARGIN && Math.abs(a.y1 - c.y1) <= SPLIT_MARGIN;
      const raggedGap = gap > width * MIN_SEAM_GAP && gap <= width * MAX_SEAM_GAP && aligned &&
        [colFill(l.x1 - 1, a, c), colFill(r.x0, a, c)].every(f => f >= STRIP_RAGGED_MIN && f <= STRIP_RAGGED_EDGE);
      if (raggedGap && !overlapping && !meeting) return !gutterBetween(a, c);
      const nested = overlapArea(a, c) >= Math.min(area(a), area(c)) * FRAGMENT_OVERLAP;
      return (overlapping || meeting) && !nested && !gutterBetween(a, c);
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const a of result) {
        const b = inStrip(a) && result.find(c => c !== a && inStrip(c) && joined(a, c));
        if (!b) continue;
        const u = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), fill: Math.min(a.fill, b.fill) };
        if (result.some(c => c !== a && c !== b && overlapArea(c, u) > area(c) * MAX_MERGE_INTRUSION)) continue;
        result = [...result.filter(c => c !== a && c !== b), u];
        changed = true;
        break;
      }
    }
  }
  return result;
}

// Split a box along straight lines that are mostly flooded gutter. Panels drawn overlapping
// their neighbours (an inset whose thin frame isn't gutter-coloured) connect the panels
// around them, but the gutter between those panels still runs most of the way across.
function splitAlongGutters(box, flooded, width, height, isGutterAt) {
  const share = (x0, y0, x1, y1, test = (i) => flooded[i]) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (test(y * width + x)) n++;
    return n / Math.max(1, (x1 - x0) * (y1 - y0));
  };
  for (const axis of ['y', 'x']) {
    const [lo, hi] = axis === 'y' ? ['y0', 'y1'] : ['x0', 'x1'];
    const minSide = (axis === 'y' ? height : width) * MIN_SPLIT_SIDE;
    const line = (k, test) => axis === 'y' ? share(box.x0, k, box.x1, k + 1, test) : share(k, box.y0, k + 1, box.y1, test);
    for (let k = box[lo] + minSide; k < box[hi] - minSide; k++) {
      if (line(k) < SPLIT_LINE_SHARE) continue;
      let end = k + 1;
      while (end < box[hi] && line(end) >= SPLIT_LINE_SHARE) end++;
      if (box[hi] - end < minSide) break;
      // A gutter is a thin straight band with artwork right up to both sides; flood that
      // leaked into dark artwork is a thick ragged blob, or a line through art of gutter colour
      const thin = end - k <= (axis === 'y' ? height : width) * MAX_SPLIT_GUTTER;
      const outside = [k - SPLIT_MARGIN, end - 1 + SPLIT_MARGIN];
      let core = 0; // the gutter itself is gutter-coloured, clearly more than the art beside it
      for (let j = k; j < end; j++) core = Math.max(core, line(j, isGutterAt));
      const clean = outside.every(j => line(j) <= SPLIT_OUTSIDE_SHARE && line(j, isGutterAt) <= SPLIT_OUTSIDE_COLOR &&
        core - line(j, isGutterAt) >= SPLIT_COLOR_JUMP);
      if (!thin || !clean) { k = end; continue; }
      const piece = (from, to) => {
        const b = { ...box, [lo]: from, [hi]: to };
        b.fill = 1 - share(b.x0, b.y0, b.x1, b.y1);
        return splitAlongGutters(b, flooded, width, height, isGutterAt);
      };
      return [...piece(box[lo], k), ...piece(end, box[hi])];
    }
  }
  return [box];
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

// Undo splits and bites made by gutter-coloured artwork (hair, shadows) that the flood
// leaked into. A gutter cuts a panel along a straight line, so the edge it leaves is
// uniformly full of content; a leak leaves a ragged edge, nearly empty right at the box
// boundary but full a little further in. Boxes separated by a ragged edge are merged;
// a box inside another with a ragged edge is a piece of it, not an inset panel; and a
// mostly empty edge is pushed outward over the leaked-into artwork to the real gutter.
function repairLeaks(boxes, flooded, width, height, isGutterAt) {
  const fill = (x0, y0, x1, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!flooded[y * width + x]) n++;
    return n / Math.max(1, (x1 - x0) * (y1 - y0));
  };
  // Content along a box side (optionally only over [from, to) of it): at the edge (2 lines)
  // and a few lines EDGE_DEPTH further in
  const edgeFill = (b, side, from, to) => {
    const vertical = side === 'top' || side === 'bottom';
    const depth = Math.round((vertical ? height : width) * EDGE_DEPTH);
    if ((vertical ? b.y1 - b.y0 : b.x1 - b.x0) < depth * 2 + 4) return null;
    const [s0, s1] = vertical ? [from ?? b.x0, to ?? b.x1] : [from ?? b.y0, to ?? b.y1];
    const band = (k, n) => {
      if (side === 'top') return fill(s0, b.y0 + k, s1, b.y0 + k + n);
      if (side === 'bottom') return fill(s0, b.y1 - k - n, s1, b.y1 - k);
      if (side === 'left') return fill(b.x0 + k, s0, b.x0 + k + n, s1);
      return fill(b.x1 - k - n, s0, b.x1 - k, s1);
    };
    return { edge: band(0, 2), inner: band(depth, 3) };
  };
  const ragged = (f) => f && f.edge < LEAK_EDGE_FILL && f.inner - f.edge >= LEAK_FILL_JUMP;
  // Two boxes facing each other across a leak: both edges mostly empty, at least one clearly ragged
  const leakSeam = (fa, fb) => fa && fb && fa.edge < SEAM_EDGE_FILL && fb.edge < SEAM_EDGE_FILL &&
    (ragged(fa) || ragged(fb));

  const inside = (a, b) => overlapArea(a, b) >= area(a) * 0.9;
  const union = (a, b) => ({
    x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), fill: Math.min(a.fill, b.fill),
  });

  const result = [...boxes];
  for (let changed = true; changed;) {
    changed = false;
    outer:
    for (let i = 0; i < result.length; i++) {
      for (let j = 0; j < result.length; j++) {
        const a = result[i], b = result[j];
        if (i === j || a.inset || b.inset) continue;
        let merge = false;
        if (inside(b, a) && area(b) < area(a)) {
          merge = ['top', 'bottom', 'left', 'right'].some(side => ragged(edgeFill(b, side)));
        } else {
          // b directly right of / below a, sharing most of the smaller box's side
          const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          const gapX = b.x0 - a.x1, gapY = b.y0 - a.y1;
          // A thin strip torn off its neighbour may touch it; other boxes that close are framed panels
          const thinX = Math.min(a.x1 - a.x0, b.x1 - b.x0) < width * THIN_BOX;
          const thinY = Math.min(a.y1 - a.y0, b.y1 - b.y0) < height * THIN_BOX;
          if (gapX >= (thinX ? -2 : width * MIN_SEAM_GAP) && gapX <= width * MAX_SEAM_GAP &&
              overlapY >= Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5) {
            const y0 = Math.max(a.y0, b.y0), y1 = Math.min(a.y1, b.y1);
            merge = leakSeam(edgeFill(a, 'right', y0, y1), edgeFill(b, 'left', y0, y1));
          } else if (gapY >= (thinY ? -2 : height * MIN_SEAM_GAP) && gapY <= height * MAX_SEAM_GAP &&
              overlapX >= Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.5) {
            const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1);
            merge = leakSeam(edgeFill(a, 'bottom', x0, x1), edgeFill(b, 'top', x0, x1));
          }
          if (merge) {
            const u = union(a, b);
            merge = result.every((c, k) => k === i || k === j || overlapArea(c, u) <= area(c) * MAX_MERGE_INTRUSION);
          }
        }
        if (!merge) continue;
        result[i] = union(a, b);
        result.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }

  // Push mostly empty edges outward over the artwork beyond, stopping at the gutter (a line
  // of nearly pure gutter colour; dark art always has some lighter pixels), the page edge
  // or another box
  for (const b of result) {
    if (b.inset) continue;
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const f = edgeFill(b, side);
      if (!f || f.edge >= SEAM_EDGE_FILL) continue;
      const vertical = side === 'top' || side === 'bottom';
      const step = side === 'top' || side === 'left' ? -1 : 1;
      const limit = Math.round((vertical ? height : width) * MAX_EXPAND);
      const line = (k) => vertical
        ? { x0: b.x0, x1: b.x1, y0: k, y1: k + 1 }
        : { x0: k, x1: k + 1, y0: b.y0, y1: b.y1 };
      let k = side === 'top' ? b.y0 - 1 : side === 'bottom' ? b.y1 : side === 'left' ? b.x0 - 1 : b.x1;
      let moved = 0;
      while (k >= 0 && k < (vertical ? height : width) && moved <= limit) {
        const l = line(k);
        let gutter = 0;
        for (let y = l.y0; y < l.y1; y++) for (let x = l.x0; x < l.x1; x++) if (isGutterAt(y * width + x)) gutter++;
        if (gutter >= (l.x1 - l.x0) * (l.y1 - l.y0) * GUTTER_LINE) break;
        if (result.some(c => c !== b && overlapArea(c, l) > 0)) break;
        k += step;
        moved++;
      }
      if (moved === 0 || moved > limit) continue;
      if (side === 'top') b.y0 = k + 1;
      else if (side === 'bottom') b.y1 = k;
      else if (side === 'left') b.x0 = k + 1;
      else b.x1 = k;
    }
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

