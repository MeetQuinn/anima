import path from 'path'
import { defineConfig } from 'vitest/config'

// Narrow test harness — added for the Activity scroll-controller hook only.
// Deliberately scoped: `include` is the hook's own test file so unrelated web
// code does not (yet) pay for a broad test surface. jsdom gives us a DOM for
// renderHook; per-test mocks (ResizeObserver, rAF, timers, element dimensions)
// live in the test file, not here, so the choreography under test stays explicit.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      src: path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
