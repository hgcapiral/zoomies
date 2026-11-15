// Renderer-side client for the panel / speech bubble detection worker.
const fs = window.require ? window.require('fs') : null;
const { fileURLToPath } = window.require ? window.require('url') : {};

let worker = null;
let nextId = 0;
const pending = new Map();
let handover = Promise.resolve(); // settles once the previous request has been sent to the worker

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
 * @param {{ rtl?: boolean, style?: 'comic' | 'manga', current?: boolean }} options rtl: right-to-left
 *   reading order (manga); style: which panel-detection pipeline to use; current: the page on screen
 *   (detected before pages requested in advance)
 * @returns {Promise<{ panels: object[], bubbles: object[] }>} rects { x, y, w, h } normalised to 0..1;
 *   each bubble also has maskUrl, a PNG of its shape over that rect (for CSS mask-image)
 */
export function detectPage(pageUrl, { rtl = false, style = 'comic', current = false } = {}) {
  // Read the file ourselves so the worker gets raw bytes (avoids file:// fetch/canvas restrictions).
  // Files are read in parallel but handed over in call order: the worker starts on whichever
  // request reaches it first, and the app asks for the page on screen first.
  const read = fs.promises.readFile(fileURLToPath(pageUrl));
  const posted = handover.then(() => read).then(file => {
    const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    const id = nextId++;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    getWorker().postMessage({ id, buffer, rtl, style, current }, [buffer]);
    return { result }; // wrapped, so `posted` settles on sending rather than on the result
  });
  handover = posted.catch(() => {}); // a page that can't be read mustn't hold up the next ones
  return posted.then(({ result }) => result);
}

// Start the worker and load the detection models in the background, so the first page
// shown in Panel or Bubble View doesn't wait for them
export function warmUpDetection() {
  getWorker().postMessage({ warmUp: true });
}
