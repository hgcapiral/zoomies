import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // onnxruntime-web loads its .wasm/.mjs at runtime (src/mangaPanels.js points it at them);
  // pre-bundling it would break those relative paths
  optimizeDeps: { exclude: ['onnxruntime-web'] },
})
