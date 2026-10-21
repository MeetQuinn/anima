import path from 'path'
import { defineConfig } from 'vitest/config'

// Web unit tests: every `src/**/*.test.{ts,tsx}` file, in jsdom. Per-test mocks
// (ResizeObserver, rAF, timers, element dimensions) live in the test files,
// not here, so the behavior under test stays explicit.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Node 25 turns on its own `localStorage` global, a bare object with no
    // methods unless `--localstorage-file` is set. Vitest only copies jsdom's
    // window properties that the global doesn't already have, so jsdom's
    // Storage never arrives and `localStorage.clear()` throws. Switching Node's
    // version off keeps jsdom's in place on every Node the repo allows (>=24).
    execArgv: ['--no-experimental-webstorage'],
  },
})
