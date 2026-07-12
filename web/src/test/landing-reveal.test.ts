/*
  Regression for the landing scroll-reveal lifecycle (docs theme, PR #513
  gate finding): VitePress keeps the Layout mounted across client-side
  navigation, so the reveal observer is NOT recreated by a remount. The
  original implementation armed `reveal-ready` once on first mount; after
  navigating landing -> docs -> back (client-side), the class was still
  armed while the fresh landing nodes were unobserved, leaving the entire
  page at opacity 0.

  The controller's contract, asserted here:
  - refresh() on a landing tree observes every [data-reveal] node FIRST,
    then arms `reveal-ready`.
  - refresh() on a non-landing tree fully disarms (class removed, old
    observer disconnected).
  - refresh() after returning to a fresh landing tree observes the CURRENT
    nodes, and intersection makes them visible (`is-revealed`).
*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRevealController } from '../../../docs/.vitepress/theme/reveal'

type IntersectionCallback = (
  entries: Array<{ target: Element; isIntersecting: boolean }>,
  observer: FakeIntersectionObserver,
) => void

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  readonly observed = new Set<Element>()
  disconnected = false
  private readonly callback: IntersectionCallback

  constructor(callback: IntersectionCallback) {
    this.callback = callback
    FakeIntersectionObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.add(target)
  }

  unobserve(target: Element): void {
    this.observed.delete(target)
  }

  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }

  intersectAll(): void {
    this.callback(
      [...this.observed].map((target) => ({ target, isIntersecting: true })),
      this,
    )
  }
}

function renderLanding(ids: string[]): void {
  document.body.innerHTML = `
    <div class="landing-home">
      ${ids.map((id) => `<p data-reveal id="${id}">${id}</p>`).join('')}
    </div>
  `
}

function renderDocsPage(): void {
  document.body.innerHTML = '<div class="vp-doc"><h1>Quickstart</h1></div>'
}

describe('landing reveal lifecycle across client-side navigation', () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
    document.documentElement.classList.remove('reveal-ready')
  })

  it('arms only after observing the current landing nodes', () => {
    renderLanding(['a', 'b', 'c'])
    const reveal = createRevealController()

    reveal.refresh()

    const [observer] = FakeIntersectionObserver.instances
    expect(observer.observed.size).toBe(3)
    expect(document.documentElement.classList.contains('reveal-ready')).toBe(
      true,
    )
  })

  it('disarms when the current page is not the landing page', () => {
    renderLanding(['a', 'b'])
    const reveal = createRevealController()
    reveal.refresh()
    const [first] = FakeIntersectionObserver.instances

    renderDocsPage()
    reveal.refresh()

    expect(first.disconnected).toBe(true)
    expect(document.documentElement.classList.contains('reveal-ready')).toBe(
      false,
    )
    expect(FakeIntersectionObserver.instances).toHaveLength(1)
  })

  it('landing -> docs -> back: the fresh landing tree is observed and can become visible', () => {
    // First landing visit.
    renderLanding(['a', 'b', 'c'])
    const reveal = createRevealController()
    reveal.refresh()
    const [first] = FakeIntersectionObserver.instances

    // Client-side navigation to a docs route (no remount, route watch fires).
    renderDocsPage()
    reveal.refresh()

    // Back to the landing page: an entirely fresh DOM tree.
    renderLanding(['a', 'b', 'c'])
    reveal.refresh()

    expect(FakeIntersectionObserver.instances).toHaveLength(2)
    const second = FakeIntersectionObserver.instances[1]
    expect(first.disconnected).toBe(true)

    // Every CURRENT node is observed by the live observer.
    const current = [...document.querySelectorAll('[data-reveal]')]
    expect(current).toHaveLength(3)
    for (const node of current) expect(second.observed.has(node)).toBe(true)

    // The hidden state is armed, and intersection reveals the current nodes.
    expect(document.documentElement.classList.contains('reveal-ready')).toBe(
      true,
    )
    second.intersectAll()
    for (const node of current) {
      expect(node.classList.contains('is-revealed')).toBe(true)
    }
  })

  it('never arms the hidden state when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    renderLanding(['a'])
    const reveal = createRevealController()

    reveal.refresh()

    expect(document.documentElement.classList.contains('reveal-ready')).toBe(
      false,
    )
  })
})
