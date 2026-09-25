// Web Worker: decodes a page image and detects its panels and speech bubbles off the UI thread.
/* global FileReaderSync */ // worker-only API
import { detectBubbles } from './bubbleDetection.js';
import { detectPanels } from './panelDetection.js';

// Each detector runs on a downscaled copy at the scale it's tuned for: bubbles need
// legible lettering, panels (used for reading order) expect ~1000px pages.
// Results are normalised, so the scales don't need to match.
const BUBBLE_SIDE = 1400;
const PANEL_SIDE = 1000;

function pixelsAt(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

// Bubble shape mask -> PNG data URL (opaque inside, transparent outside) for CSS mask-image
async function maskToDataUrl({ width, height, data }) {
  const pixels = new ImageData(width, height);
  for (let i = 0; i < data.length; i++) {
    pixels.data[i * 4 + 3] = data[i] ? 255 : 0;
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(pixels, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new FileReaderSync().readAsDataURL(blob);
}

self.onmessage = async ({ data: { id, buffer, rtl } }) => {
  try {
    const bitmap = await createImageBitmap(new Blob([buffer]));
    const panels = detectPanels(pixelsAt(bitmap, PANEL_SIDE), { rtl });
    const detected = detectBubbles(pixelsAt(bitmap, BUBBLE_SIDE), { panels, rtl });
    bitmap.close();
    const bubbles = await Promise.all(detected.map(async ({ mask, ...rect }) => ({
      ...rect,
      maskUrl: await maskToDataUrl(mask),
    })));
    self.postMessage({ id, result: { panels, bubbles } });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
