import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Minimal harness setup: unmount rendered hooks/components between tests so
// each case starts from a clean DOM. Everything else the scroll tests need
// (ResizeObserver, requestAnimationFrame, element dimensions, timers) is mocked
// explicitly inside the test file, per the harness-boundary agreement.
afterEach(() => {
  cleanup()
})
