// Renderer for main.cjs: decode pages like the app's worker, run the app's bubble detector and
// the bubble models, report results + timings, and draw comparison rows for sampled pages.
import * as ort from '/ort/ort.min.mjs';

const { ipcRenderer } = window.require('electron');
const fs = window.require('fs');
const path = window.require('path');
const { Buffer } = window.require('buffer');
const { detectPanels, orderBoxes } = await import('/src/panelDetection.js');
const { detectBubbles, bubblesFromBoxes, orderByPanel } = await import('/src/bubbleDetection.js');
const { bubbleItems } = await import('/src/bubbleModel.js'); // the app's own post-processing
const id = new URLSearchParams(location.search).get('id');

const PANEL_SIDE = 1000, BUBBLE_SIDE = 1400; // as in src/bubbleWorker.js
const NMS_IOU = 0.45;
const TEXT_IN_BUBBLE = 0.5; // a text box this much inside a kept bubble is that bubble's lettering
// What Bubble View steps through: balloons/captions, plus text that has no balloon
const MODELS = {
  ogkalu: {
    label: 'ogkalu RT-DETR', url: '/models/ogkalu/detector.onnx', size: 640, format: 'rtdetr',
    bubble: [0], text: [2], minScore: 0.3,             // 0 bubble, 1 text_bubble, 2 text_free
    ep: 'wasm', // onnxruntime-web 1.31.1's WebGPU AveragePool lacks ceil_mode (ResNet-D backbone)
  },
  ogkaluS: {
    label: 'ogkalu v4-s int8', url: '/models/ogkalu/detector-v4-s_int8.onnx', size: 640, format: 'rtdetr',
    bubble: [0], text: [2], minScore: 0.3, ep: 'wasm', // int8 ops have no WebGPU kernels
  },
  koharu: {
    label: 'Koharu seg', url: '/models/koharu-seg/koharu-yolo26s-seg.onnx', size: 1024, format: 'e2e-seg',
    bubble: [2], text: [1], minScore: 0.25,            // 0 frame, 1 dialogue_text, 2 balloon, 3 onomatopoeia
  },
  kitsumed: {
    label: 'kitsumed v8m-seg', url: '/models/kitsumed/model_dynamic.onnx', size: 640, format: 'v8-seg',
    bubble: [0], text: [], minScore: 0.25,             // 0 speech bubble
  },
};
const PANEL_MODEL = { url: '/public/models/manga-panels-yolo26n.onnx', size: 640 };
const ALL_METHODS = ['rules', 'app', ...Object.keys(MODELS)];
let METHODS = ALL_METHODS; // set per job (--methods)
const LABELS = { rules: 'current rules', app: 'new: model + shapes', ...Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, m.label])) };

function pixelsAt(bitmap, maxSide) { // same as src/bubbleWorker.js
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

// Model input as CHW floats in 0..1. Letterboxed (Ultralytics) or stretched to a square (RT-DETR).
function toTensor(bitmap, size, stretch) {
  const r = size / Math.max(bitmap.width, bitmap.height);
  const w = stretch ? size : Math.round(bitmap.width * r), h = stretch ? size : Math.round(bitmap.height * r);
  const padX = stretch ? 0 : Math.round((size - w) / 2 - 0.1), padY = stretch ? 0 : Math.round((size - h) / 2 - 0.1);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, padX, padY, w, h);
  const { data } = ctx.getImageData(0, 0, size, size);
  const n = size * size, t = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    t[i] = data[i * 4] / 255; t[n + i] = data[i * 4 + 1] / 255; t[2 * n + i] = data[i * 4 + 2] / 255;
  }
  // Input pixel -> page fraction
  const sx = stretch ? 1 / size : 1 / (r * bitmap.width), sy = stretch ? 1 / size : 1 / (r * bitmap.height);
  const map = { x: v => (v - padX) * sx, y: v => (v - padY) * sy };
  return { tensor: new ort.Tensor('float32', t, [1, 3, size, size]), map };
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return (ix * iy) / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - ix * iy);
};
const insideShare = (a, b) => { // share of a's area inside b
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return (ix * iy) / ((a.x1 - a.x0) * (a.y1 - a.y0));
};
const nms = dets => {
  const kept = [];
  for (const d of [...dets].sort((a, b) => b.s - a.s)) if (kept.every(k => iou(k, d) < NMS_IOU)) kept.push(d);
  return kept;
};

// Raw model output -> detections { x0, y0, x1, y1 (model input px), s, c, coef? }
function decode(model, out) {
  const dets = [];
  if (model.format === 'rtdetr') { // labels [1,N], boxes [1,N,4] xyxy scaled by orig_target_sizes, scores [1,N]
    const { labels, boxes, scores } = out;
    for (let i = 0; i < scores.dims[1]; i++) {
      const b = boxes.data.subarray(i * 4, i * 4 + 4);
      dets.push({ x0: b[0], y0: b[1], x1: b[2], y1: b[3], s: scores.data[i], c: Number(labels.data[i]) });
    }
    return dets;
  }
  const o = out.output0, d = o.data;
  if (model.format === 'v8-seg') { // [1, 4 + nc + 32, N]: cx, cy, w, h, class scores, mask coefficients
    const [, rows, N] = o.dims, nc = rows - 4 - 32;
    for (let i = 0; i < N; i++) {
      let s = 0, c = 0;
      for (let k = 0; k < nc; k++) if (d[(4 + k) * N + i] > s) { s = d[(4 + k) * N + i]; c = k; }
      if (s < model.minScore) continue;
      const cx = d[i], cy = d[N + i], w = d[2 * N + i], h = d[3 * N + i];
      const coef = new Float32Array(32);
      for (let k = 0; k < 32; k++) coef[k] = d[(4 + nc + k) * N + i];
      dets.push({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, s, c, coef });
    }
    return nms(dets);
  }
  const [, n, k] = o.dims; // e2e(-seg): [1, 300, 6 (+32)]: x1, y1, x2, y2, score, class (, coefficients)
  for (let i = 0; i < n; i++) {
    dets.push({ x0: d[i * k], y0: d[i * k + 1], x1: d[i * k + 2], y1: d[i * k + 3], s: d[i * k + 4],
      c: Math.round(d[i * k + 5]), coef: k > 6 ? d.slice(i * k + 6, i * k + k) : null });
  }
  return dets;
}

// Instance mask on the prototype grid, cropped to the box; `rect` is the page area it covers
function maskOf(det, protos, inputSize, map) {
  const [, P, PH, PW] = protos.dims;
  const k = inputSize / PW;
  const u0 = Math.max(0, Math.floor(det.x0 / k)), v0 = Math.max(0, Math.floor(det.y0 / k));
  const u1 = Math.min(PW, Math.ceil(det.x1 / k)), v1 = Math.min(PH, Math.ceil(det.y1 / k));
  const w = Math.max(0, u1 - u0), h = Math.max(0, v1 - v0);
  const bits = new Uint8Array(w * h);
  let on = 0;
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    let sum = 0;
    const off = (v0 + v) * PW + (u0 + u);
    for (let c = 0; c < P; c++) sum += det.coef[c] * protos.data[c * PH * PW + off];
    if (sum > 0) { bits[v * w + u] = 1; on++; }
  }
  const x = map.x(u0 * k), y = map.y(v0 * k);
  return { w, h, bits, rect: { x, y, w: map.x(u1 * k) - x, h: map.y(v1 * k) - y }, fill: w * h ? on / (w * h) : 0 };
}

let sessions = null;
async function loadSessions(ep) {
  sessions = {};
  const needed = new Set(METHODS.flatMap(m => (m === 'app' ? ['ogkaluS'] : [m])));
  for (const [name, m] of Object.entries(MODELS)) {
    if (!needed.has(name)) continue;
    sessions[name] = await ort.InferenceSession.create(m.url, { executionProviders: [m.ep || ep] });
  }
  sessions.panels = await ort.InferenceSession.create(PANEL_MODEL.url, { executionProviders: [ep] });
}

// The app's panels: manga model for manga, rules for comics (src/bubbleWorker.js + mangaPanels.js)
async function findPanels(bitmap, page) {
  if (page.style !== 'manga') return detectPanels(pixelsAt(bitmap, PANEL_SIDE), { style: page.style, rtl: page.rtl });
  const { tensor, map } = toTensor(bitmap, PANEL_MODEL.size, false);
  const { output0 } = await sessions.panels.run({ images: tensor });
  const boxes = decode({ format: 'e2e' }, { output0 })
    .filter(d => d.s >= 0.25 && d.c === 0)
    .map(d => ({ x0: map.x(d.x0) * 1000, y0: map.y(d.y0) * 1000, x1: map.x(d.x1) * 1000, y1: map.y(d.y1) * 1000 }))
    .map(b => ({ x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(1000, b.x1), y1: Math.min(1000, b.y1) }))
    .filter(b => b.x1 > b.x0 && b.y1 > b.y0);
  if (boxes.length < 2) return [{ x: 0, y: 0, w: 1, h: 1 }];
  return orderBoxes(boxes, { x: 30, y: 30 }, page.rtl)
    .map(b => ({ x: b.x0 / 1000, y: b.y0 / 1000, w: (b.x1 - b.x0) / 1000, h: (b.y1 - b.y0) / 1000 }));
}

async function runModel(name, bitmap, panels, rtl) {
  const m = MODELS[name];
  const { tensor, map } = toTensor(bitmap, m.size, m.format === 'rtdetr');
  const feeds = { images: tensor };
  if (m.format === 'rtdetr') feeds.orig_target_sizes = new ort.Tensor('int64', BigInt64Array.from([BigInt(m.size), BigInt(m.size)]), [1, 2]);
  const out = await sessions[name].run(feeds);
  const dets = decode(m, out).filter(d => d.s >= m.minScore && (m.bubble.includes(d.c) || m.text.includes(d.c)));
  // Lettering inside a kept bubble belongs to it; only text without a balloon is its own item
  const bubbles = dets.filter(d => m.bubble.includes(d.c));
  const items = dets.filter(d => m.bubble.includes(d.c) || bubbles.every(b => insideShare(d, b) < TEXT_IN_BUBBLE));
  const W = bitmap.width, H = bitmap.height;
  const boxes = items.map(d => {
    const b = {
      x0: Math.max(0, map.x(d.x0)) * W, y0: Math.max(0, map.y(d.y0)) * H,
      x1: Math.min(1, map.x(d.x1)) * W, y1: Math.min(1, map.y(d.y1)) * H,
      s: d.s, text: m.text.includes(d.c),
    };
    if (d.coef) b.mask = maskOf(d, out.output1, m.size, map);
    return b;
  }).filter(b => b.x1 > b.x0 && b.y1 > b.y0);
  return orderByPanel(boxes, panels, W, H, rtl).map(b => ({
    x: b.x0 / W, y: b.y0 / H, w: (b.x1 - b.x0) / W, h: (b.y1 - b.y0) / H, s: +b.s.toFixed(3),
    ...(b.text ? { text: 1 } : {}), ...(b.mask ? { fill: +b.mask.fill.toFixed(3) } : {}), _mask: b.mask,
  }));
}

// What the app now does (src/bubbleWorker.js): the small ogkalu model, bubbleItems, bubblesFromBoxes
async function runApp(bitmap, panels, rtl) {
  const { tensor } = toTensor(bitmap, 640, true);
  const sizes = new ort.Tensor('int64', BigInt64Array.from([640n, 640n]), [1, 2]);
  const { labels, boxes, scores } = await sessions.ogkaluS.run({ images: tensor, orig_target_sizes: sizes });
  const items = bubbleItems(labels.data, boxes.data, scores.data);
  return bubblesFromBoxes(pixelsAt(bitmap, BUBBLE_SIDE), items, { panels, rtl }).map(({ mask, ...b }) => {
    let on = 0;
    for (const v of mask.data) on += v;
    // fill 1: a rectangle (caption, balloon-less text, or a balloon whose shape couldn't be found)
    return { ...b, s: 1, fill: +(on / mask.data.length).toFixed(3), _mask: { w: mask.width, h: mask.height, bits: mask.data, rect: b } };
  });
}

const COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00', '#bf5af2', '#ff9f0a', '#64d2ff', '#ff2d55'];
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));

async function drawRow(bitmap, page, res, file) {
  const W = bitmap.width, H = bitmap.height;
  const TW = METHODS.length <= 2 ? 560 : 340, TH = Math.round((TW * H) / W), PAD = 10, LABEL = 24;
  const canvas = new OffscreenCanvas(PAD + METHODS.length * (TW + PAD), LABEL + TH + PAD);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1c1c1e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  METHODS.forEach((m, j) => {
    const ox = PAD + j * (TW + PAD), oy = LABEL;
    ctx.drawImage(bitmap, ox, oy, TW, TH);
    ctx.fillStyle = '#fff';
    ctx.font = '14px sans-serif';
    ctx.fillText(`${page.book} p${page.index + 1} · ${LABELS[m]} · ${res[m].length}`, ox, 17);
    res[m].forEach((p, k) => {
      const color = COLORS[k % COLORS.length];
      if (p._mask) { // the bubble's own shape, tinted
        const { w, h, bits, rect } = p._mask;
        const img = new ImageData(Math.max(1, w), Math.max(1, h));
        const [r, g, b] = rgb(color);
        for (let i = 0; i < bits.length; i++) if (bits[i]) img.data.set([r, g, b, 110], i * 4);
        const tmp = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
        tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.drawImage(tmp, ox + rect.x * TW, oy + rect.y * TH, rect.w * TW, rect.h * TH);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = p._mask ? 1.5 : 2.5;
      ctx.setLineDash(p.text ? [5, 3] : []); // dashed: text with no balloon
      ctx.strokeRect(ox + p.x * TW, oy + p.y * TH, p.w * TW, p.h * TH);
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillRect(ox + p.x * TW, oy + p.y * TH, 17, 15);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(String(k + 1), ox + p.x * TW + 2, oy + p.y * TH + 12);
    });
  });
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
}

ipcRenderer.on('run', async (_e, job) => {
  try {
    ort.env.wasm.wasmPaths = '/ort/';
    ort.env.wasm.numThreads = job.threads;
    if (job.methods) METHODS = job.methods;
    await loadSessions(job.ep);
    const sample = new Set(job.sample);
    const out = [];
    for (const page of job.pages) {
      const bytes = fs.readFileSync(page.file);
      let t = performance.now();
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const time = { decode: performance.now() - t };
      t = performance.now();
      const panels = await findPanels(bitmap, page);
      time.panels = performance.now() - t;
      const res = {};
      t = performance.now();
      res.rules = detectBubbles(pixelsAt(bitmap, BUBBLE_SIDE), { panels, rtl: page.rtl }).map(({ mask, ...b }) => ({
        ...b, s: 1, _mask: { w: mask.width, h: mask.height, bits: mask.data, rect: b },
      }));
      time.rules = performance.now() - t;
      if (METHODS.includes('app')) {
        t = performance.now();
        res.app = await runApp(bitmap, panels, page.rtl);
        time.app = performance.now() - t;
      }
      for (const name of Object.keys(MODELS)) {
        if (!METHODS.includes(name)) continue;
        t = performance.now();
        res[name] = await runModel(name, bitmap, panels, page.rtl);
        time[name] = performance.now() - t;
      }
      if (sample.has(`${page.book}:${page.index}`)) await drawRow(bitmap, page, res, path.join(job.outDir, 'rows', `${page.book}-${page.index}.png`));
      bitmap.close();
      for (const m of METHODS) for (const p of res[m]) delete p._mask;
      out.push({ book: page.book, index: page.index, res, time });
      ipcRenderer.send('page-done');
    }
    ipcRenderer.send(`done-${id}`, { pages: out, env: { crossOriginIsolated, threads: job.threads, ep: job.ep } });
  } catch (error) {
    ipcRenderer.send(`done-${id}`, { error: String(error?.stack || error) });
  }
});

ipcRenderer.on('compose', async (_e, { groups, outDir }) => {
  try {
    for (const [i, files] of groups.entries()) {
      const bitmaps = await Promise.all(files.map(f => createImageBitmap(new Blob([fs.readFileSync(f)]))));
      const canvas = new OffscreenCanvas(Math.max(...bitmaps.map(b => b.width)), bitmaps.reduce((s, b) => s + b.height, 0));
      const ctx = canvas.getContext('2d');
      let y = 0;
      for (const b of bitmaps) { ctx.drawImage(b, 0, y); y += b.height; b.close(); }
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      fs.writeFileSync(path.join(outDir, `sheet-${String(i + 1).padStart(2, '0')}.png`), Buffer.from(await blob.arrayBuffer()));
    }
    ipcRenderer.send(`done-${id}`, {});
  } catch (error) {
    ipcRenderer.send(`done-${id}`, { error: String(error?.stack || error) });
  }
});

ipcRenderer.send(`ready-${id}`);
