/*
  Lifecycle of the homepage engine across client-side navigation (replaces
  the landing-reveal regression from PR #513). VitePress keeps the Layout
  mounted, so the controller never remounts: refresh() runs after every route
  change and must start against the `.ov` tree that exists NOW, and fully stop
  on any other page. If it didn't, a docs page would keep the homepage's
  cream "morning" nav, and the loop would keep drawing a detached canvas.

  The engine runs against the real markup from docs/index.md, so a renamed or
  dropped element id fails here rather than on the live site.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOvernightController } from '../../../docs/.vitepress/theme/overnight'
import homepage from '../../../docs/index.md?raw'

const homeMarkup = homepage.slice(homepage.indexOf('<div class="ov">'))
const html = document.documentElement

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observed: Element[] = []
  disconnected = false
  constructor() {
    FakeResizeObserver.instances.push(this)
  }
  observe(target: Element): void {
    this.observed.push(target)
  }
  disconnect(): void {
    this.disconnected = true
  }
}

// A 2D context that accepts every call and property: jsdom has no canvas.
const noopContext: unknown = new Proxy(function () {}, {
  get: () => noopContext,
  apply: () => noopContext,
})

function renderHome(): void {
  document.body.innerHTML = homeMarkup
}

function renderDocsPage(): void {
  document.body.innerHTML = '<div class="vp-doc"><h1>Quickstart</h1></div>'
}

describe('homepage engine lifecycle across client-side navigation', () => {
  let nextFrame = 0
  const cancelled: number[] = []

  beforeEach(() => {
    FakeResizeObserver.instances = []
    cancelled.length = 0
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.stubGlobal('requestAnimationFrame', () => ++nextFrame)
    vi.stubGlobal('cancelAnimationFrame', (id: number) => cancelled.push(id))
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      noopContext as CanvasRenderingContext2D,
    )
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    })
    html.classList.add('ov-boot')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    html.className = ''
  })

  it('starts on the homepage and lifts the first-paint hold', () => {
    renderHome()
    createOvernightController().refresh()

    expect(html.classList.contains('ov-live')).toBe(true)
    expect(html.classList.contains('ov-boot')).toBe(false)
    expect(FakeResizeObserver.instances[0].observed).toEqual([
      document.querySelector('.ov'),
    ])
  })

  it('stops completely on a docs page', () => {
    renderHome()
    const overnight = createOvernightController()
    overnight.refresh()
    html.classList.add('ov-morning') // scrolled down to the morning section

    renderDocsPage()
    overnight.refresh()

    expect(FakeResizeObserver.instances[0].disconnected).toBe(true)
    expect(cancelled).toContain(nextFrame)
    expect(html.classList.contains('ov-live')).toBe(false)
    expect(html.classList.contains('ov-morning')).toBe(false)
    expect(FakeResizeObserver.instances).toHaveLength(1)
  })

  it('home -> docs -> back: restarts against the fresh homepage tree', () => {
    renderHome()
    const overnight = createOvernightController()
    overnight.refresh()
    renderDocsPage()
    overnight.refresh()

    renderHome()
    overnight.refresh()

    const [first, second] = FakeResizeObserver.instances
    expect(first.disconnected).toBe(true)
    expect(second.observed).toEqual([document.querySelector('.ov')])
    expect(html.classList.contains('ov-live')).toBe(true)
  })
})
