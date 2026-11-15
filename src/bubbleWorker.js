// Web Worker: decodes a page image and detects its panels and speech bubbles off the UI thread.
/* global FileReaderSync */ // worker-only API
import { detectBubbles, bubblesFromBoxes } from './bubbleDetection.js';
import { detectBubbleBoxes } from './bubbleModel.js';
import { detectPanels } from './panelDetection.js';
import { detectMangaPanels } from './mangaPanels.js';

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

// Manga pages go to the trained model; comics (and manga, if the model can't run) to the rules
let panelModelFailed = false;
async function findPanels(bitmap, { style, rtl }) {
  if (style === 'manga' && !panelModelFailed) {
    try {
      return await detectMangaPanels(bitmap, { rtl });
    } catch (error) {
      panelModelFailed = true;
      console.warn('Manga panel model unavailable, using the rule-based detector:', error);
    }
  }
  return detectPanels(pixelsAt(bitmap, PANEL_SIDE), { style, rtl });
}

// Bubbles from the trained model (shapes from the page's flat-colour regions), or the rules
let bubbleModelFailed = false;
async function findBubbles(bitmap, { panels, rtl }) {
  const image = pixelsAt(bitmap, BUBBLE_SIDE);
  if (!bubbleModelFailed) {
    try {
      return bubblesFromBoxes(image, await detectBubbleBoxes(bitmap), { panels, rtl });
    } catch (error) {
      bubbleModelFailed = true;
      console.warn('Bubble model unavailable, using the rule-based detector:', error);
    }
  }
  return detectBubbles(image, { panels, rtl });
}

self.onmessage = async ({ data: { id, buffer, rtl, style } }) => {
  try {
    const bitmap = await createImageBitmap(new Blob([buffer]));
    const panels = await findPanels(bitmap, { style, rtl });
    const detected = await findBubbles(bitmap, { panels, rtl });
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
