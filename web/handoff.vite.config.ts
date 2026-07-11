import { resolve } from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(__dirname, 'handoff'),
  publicDir: resolve(__dirname, 'handoff/public'),
  build: {
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    outDir: resolve(__dirname, '../dist/handoff'),
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared'),
    },
  },
});
