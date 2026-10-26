import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: { build: { rollupOptions: { input: resolve('src/main/app.ts'), output: { format: 'cjs', entryFileNames: 'app.cjs' } } } },
  // Two sandboxed preloads: the shell bridge (index) and the browser-tab recorder. Sandboxed preloads cannot
  // require sibling chunks, so the entries must share no runtime modules (verified after build: no chunks/ output).
  preload: { build: { externalizeDeps: false, rollupOptions: {
    input: { index: resolve('src/preload/index.ts'), recorder: resolve('src/recorder/preload.ts') },
    output: { format: 'cjs', entryFileNames: '[name].cjs' },
  } } },
  renderer: { root: 'src/renderer', build: { rollupOptions: { input: resolve('src/renderer/index.html') } } },
});
