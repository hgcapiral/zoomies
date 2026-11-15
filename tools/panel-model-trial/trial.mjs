// Renderer for main.cjs: decode pages like the app's worker, run the rules and the models,
// report results + timings, and draw comparison rows for sampled pages.
import * as ort from '/ort/ort.min.mjs';

const { ipcRenderer } = window.require('electron');
const fs = window.require('fs');
const path = window.require('path');
const { Buffer } = window.require('buffer');
const { detectPanels, orderBoxes } = await import('/src/panelDetection.js');
const id = new URLSearchParams(location.search).get('id');

const MIN_SCORE = 0.25;   // keep detections at least this confident (Ultralytics' default)
const NMS_IOU = 0.45;     // YOLOv8 output needs NMS; the YOLO26 models are NMS-free
const MODELS = {
  manga:   { url: '/models/manga-yolo26n/panel-yolo26n.onnx', size: 640, format: 'e2e', panelClass: 0 },
  inkwell: { url: '/models/inkwell/best.onnx', size: 640, format: 'v8' },
  koharu:  { url: '/models/koharu-seg/koharu-yolo26s-seg.onnx', size: 1024, format: 'e2e-seg', panelClass: 0 },
};
const METHODS = ['rules', ...Object.keys(MODELS)];
const LABELS = { rules: 'current rules', manga: 'manga YOLO26n', inkwell: 'Inkwell YOLOv8n', koharu: 'Koharu seg' };

function pixelsAt(bitmap, maxSide) { // same as src/bubbleWorker.js
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

// Ultralytics-style letterbox: fit the long side, pad with grey (114) to a centred square
function letterbox(bitmap, size) {
  const r = size / Math.max(bitmap.width, bitmap.height);
  const w = Math.round(bitmap.width * r), h = Math.round(bitmap.height * r);
  const padX = Math.round((size - w) / 2 - 0.1), padY = Math.round((size - h) / 2 - 0.1);
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
  return { tensor: new ort.Tensor('float32', t, [1, 3, size, size]), r, padX, padY };
}

const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  return inter / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter);
};

function nms(dets) {
  const kept = [];
  for (const d of [...dets].sort((a, b) => b.s - a.s)) if (kept.every(k => iou(k, d) < NMS_IOU)) kept.push(d);
  return kept;
}

// Model output -> boxes in letterbox pixels { x0, y0, x1, y1, s } (+ mask coefficients)
function decode(model, out) {
  const o = out.output0, d = o.data;
  const dets = [];
  if (model.format === 'v8') { // [1, 5, N]: cx, cy, w, h, conf
    const N = o.dims[2];
    for (let i = 0; i < N; i++) {
      const s = d[4 * N + i];
      if (s < MIN_SCORE) continue;
      const cx = d[i], cy = d[N + i], w = d[2 * N + i], h = d[3 * N + i];
      dets.push({ x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, s });
    }
    return nms(dets);
  }
  const [, n, k] = o.dims; // [1, 300, 6 | 38]: x1, y1, x2, y2, score, class (, 32 mask coefficients)
  for (let i = 0; i < n; i++) {
    const s = d[i * k + 4];
    if (s < MIN_SCORE || Math.round(d[i * k + 5]) !== model.panelClass) continue;
    dets.push({ x0: d[i * k], y0: d[i * k + 1], x1: d[i * k + 2], y1: d[i * k + 3], s,
      coef: k > 6 ? d.slice(i * k + 6, i * k + k) : null });
  }
  return dets;
}

// Instance mask of a segmentation detection on the prototype grid, cropped to its box
function maskOf(det, protos) {
  const [, P, PH, PW] = protos.dims;
  const scale = PW / 1024; // prototypes are 1/4 of the input
  const u0 = Math.max(0, Math.floor(det.x0 * scale)), v0 = Math.max(0, Math.floor(det.y0 * scale));
  const u1 = Math.min(PW, Math.ceil(det.x1 * scale)), v1 = Math.min(PH, Math.ceil(det.y1 * scale));
  const w = Math.max(0, u1 - u0), h = Math.max(0, v1 - v0);
  const bits = new Uint8Array(w * h);
  let on = 0;
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    let sum = 0;
    const off = (v0 + v) * PW + (u0 + u);
    for (let c = 0; c < P; c++) sum += det.coef[c] * protos.data[c * PH * PW + off];
    if (sum > 0) { bits[v * w + u] = 1; on++; } // sigmoid(sum) > 0.5
  }
  return { u0, v0, w, h, bits, fill: w * h ? on / (w * h) : 0, toInput: 1 / scale };
}

// Letterbox pixels -> page-normalised boxes in reading order
function toPage(dets, lb, W, H, rtl) {
  const boxes = dets.map(d => {
    const c = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const x0 = c((d.x0 - lb.padX) / lb.r / W, 0, 1), x1 = c((d.x1 - lb.padX) / lb.r / W, 0, 1);
    const y0 = c((d.y0 - lb.padY) / lb.r / H, 0, 1), y1 = c((d.y1 - lb.padY) / lb.r / H, 0, 1);
    return { x0: x0 * 1000, y0: y0 * 1000, x1: x1 * 1000, y1: y1 * 1000, d };
  }).filter(b => b.x1 > b.x0 && b.y1 > b.y0);
  return orderBoxes(boxes, { x: 30, y: 30 }, rtl).map(b => ({
    x: b.x0 / 1000, y: b.y0 / 1000, w: (b.x1 - b.x0) / 1000, h: (b.y1 - b.y0) / 1000,
    s: +b.d.s.toFixed(3), ...(b.d.mask ? { fill: +b.d.mask.fill.toFixed(3) } : {}), _mask: b.d.mask,
  }));
}

const COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00', '#bf5af2', '#ff9f0a', '#64d2ff', '#ff2d55'];

async function drawRow(bitmap, page, res, lbs, file) {
  const W = bitmap.width, H = bitmap.height;
  const TW = 320, TH = Math.round((TW * H) / W), PAD = 10, LABEL = 24;
  const canvas = new OffscreenCanvas(PAD + METHODS.length * (TW + PAD), LABEL + TH + PAD);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1c1c1e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  METHODS.forEach((m, j) => {
    const ox = PAD + j * (TW + PAD), oy = LABEL;
    ctx.drawImage(bitmap, ox, oy, TW, TH);
    const panels = res[m].filter(p => p.w * p.h < 0.9); // the app ignores full-page "panels"
    ctx.fillStyle = '#fff';
    ctx.font = '14px sans-serif';
    ctx.fillText(`${page.book} p${page.index + 1} · ${LABELS[m]} · ${panels.length || 'none'}`, ox, 17);
    panels.forEach((p, k) => {
      const color = COLORS[k % COLORS.length];
      if (p._mask) { // segmentation: tint the panel's own shape
        const { u0, v0, w, h, bits, toInput } = p._mask;
        const img = new ImageData(w, h);
        const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
        for (let i = 0; i < bits.length; i++) if (bits[i]) img.data.set([r, g, b, 90], i * 4);
        const tmp = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
        tmp.getContext('2d').putImageData(img, 0, 0);
        const lb = lbs[m], k2 = TW / W / lb.r;
        ctx.drawImage(tmp, ox + (u0 * toInput - lb.padX) * k2, oy + (v0 * toInput - lb.padY) * k2, w * toInput * k2, h * toInput * k2);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.setLineDash(p.s < 0.5 ? [6, 4] : []);
      ctx.strokeRect(ox + p.x * TW + 1.5, oy + p.y * TH + 1.5, p.w * TW - 3, p.h * TH - 3);
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillRect(ox + p.x * TW + 3, oy + p.y * TH + 3, 20, 18);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(String(k + 1), ox + p.x * TW + 7, oy + p.y * TH + 17);
    });
  });
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
}

ipcRenderer.on('run', async (_e, job) => {
  try {
    ort.env.wasm.wasmPaths = '/ort/';
    ort.env.wasm.numThreads = job.threads;
    const env = { crossOriginIsolated, threads: job.threads, ep: job.ep };
    const sessions = {};
    for (const [name, m] of Object.entries(MODELS)) {
      sessions[name] = await ort.InferenceSession.create(m.url, { executionProviders: [job.ep] });
    }
    const sample = new Set(job.sample);
    const out = [];
    for (const page of job.pages) {
      const bytes = fs.readFileSync(page.file);
      let t = performance.now();
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const time = { decode: performance.now() - t };
      const res = {}, lbs = {};
      t = performance.now();
      res.rules = detectPanels(pixelsAt(bitmap, 1000), { style: page.style, rtl: page.rtl }).map(p => ({ ...p, s: 1 }));
      time.rules = performance.now() - t;
      for (const [name, m] of Object.entries(MODELS)) {
        t = performance.now();
        const lb = letterbox(bitmap, m.size);
        const o = await sessions[name].run({ [sessions[name].inputNames[0]]: lb.tensor });
        const dets = decode(m, o);
        if (m.format === 'e2e-seg') for (const d of dets) d.mask = maskOf(d, o.output1);
        res[name] = toPage(dets, lb, bitmap.width, bitmap.height, page.rtl);
        lbs[name] = lb;
        time[name] = performance.now() - t;
      }
      const key = `${page.book}:${page.index}`;
      if (sample.has(key)) await drawRow(bitmap, page, res, lbs, path.join(job.outDir, 'rows', `${page.book}-${page.index}.png`));
      bitmap.close();
      for (const m of METHODS) for (const p of res[m]) delete p._mask;
      out.push({ book: page.book, index: page.index, res, time });
      ipcRenderer.send('page-done');
    }
    ipcRenderer.send(`done-${id}`, { pages: out, env });
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
