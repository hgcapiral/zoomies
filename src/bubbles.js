// Renderer-side client for the panel / speech bubble detection worker.
const fs = window.require ? window.require('fs') : null;
const { fileURLToPath } = window.require ? window.require('url') : {};

let worker = null;
let nextId = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./bubbleWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: { id, result, error } }) => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    };
  }
  return worker;
}

/**
 * Detect the panels and the speech bubbles / captions on a page, each in reading order.
 * @param {string} pageUrl file:// URL of the extracted page image
 * @param {{ rtl?: boolean, style?: 'comic' | 'manga' }} options rtl: right-to-left reading order (manga);
 *   style: which panel-detection pipeline to use
 * @returns {Promise<{ panels: object[], bubbles: object[] }>} rects { x, y, w, h } normalised to 0..1;
 *   each bubble also has maskUrl, a PNG of its shape over that rect (for CSS mask-image)
 */
export async function detectPage(pageUrl, { rtl = false, style = 'comic' } = {}) {
  // Read the file ourselves so the worker gets raw bytes (avoids file:// fetch/canvas restrictions)
  const file = await fs.promises.readFile(fileURLToPath(pageUrl));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, buffer, rtl, style }, [buffer]);
  });
}
