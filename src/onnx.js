// onnxruntime-web for the detection worker: CPU (WASM), one thread.
// More threads would need cross-origin isolation, which the app doesn't set up; WebGPU lacks
// kernels the bubble model needs (int8 ops) in onnxruntime-web 1.31.1.
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';

ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
ort.env.wasm.numThreads = 1;

export { ort };

/**
 * A page as a model's input: RGB floats in 0..1, CHW order, `size` × `size`.
 * letterbox: fit the long side and centre on grey (114), as Ultralytics models expect;
 * otherwise stretch to the square (RT-DETR's processor).
 * @returns {{ tensor: ort.Tensor, toPage: { x: (v: number) => number, y: (v: number) => number } }}
 *   toPage maps input pixels to page fractions
 */
export function imageTensor(bitmap, size, { letterbox }) {
  const scale = size / Math.max(bitmap.width, bitmap.height);
  const w = letterbox ? Math.round(bitmap.width * scale) : size;
  const h = letterbox ? Math.round(bitmap.height * scale) : size;
  const padX = letterbox ? Math.round((size - w) / 2 - 0.1) : 0;
  const padY = letterbox ? Math.round((size - h) / 2 - 0.1) : 0;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'rgb(114, 114, 114)';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, padX, padY, w, h);
  const { data } = ctx.getImageData(0, 0, size, size);
  const n = size * size;
  const chw = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    chw[i] = data[i * 4] / 255;
    chw[n + i] = data[i * 4 + 1] / 255;
    chw[2 * n + i] = data[i * 4 + 2] / 255;
  }
  return {
    tensor: new ort.Tensor('float32', chw, [1, 3, size, size]),
    toPage: letterbox
      ? { x: v => (v - padX) / (scale * bitmap.width), y: v => (v - padY) / (scale * bitmap.height) }
      : { x: v => v / size, y: v => v / size },
  };
}
