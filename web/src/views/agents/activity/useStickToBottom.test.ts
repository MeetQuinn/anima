import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStickToBottom, type StickToBottomOptions } from './useStickToBottom';

// ---------------------------------------------------------------------------
// Harness. jsdom does not lay out, so scrollHeight/scrollTop/clientHeight are
// mocked on a fake element with browser-accurate scrollTop clamping. RO, rAF,
// and setTimeout are mocked explicitly (per the locked test-harness boundary)
// so every scroll write and mode transition is asserted deterministically.
// Assertions target MODES and scroll writes, never rendered DOM.
// ---------------------------------------------------------------------------

interface MockContainer {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  _fire(type: string, ev?: unknown): void;
  _listenerCount(type: string): number;
}

function makeContainer(scrollHeight = 1000, clientHeight = 500): MockContainer {
  let _scrollHeight = scrollHeight;
  const _clientHeight = clientHeight;
  let _scrollTop = 0;
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    get scrollHeight() {
      return _scrollHeight;
    },
    set scrollHeight(v: number) {
      _scrollHeight = v;
    },
    get clientHeight() {
      return _clientHeight;
    },
    set clientHeight(_v: number) {
      /* fixed viewport */
    },
    get scrollTop() {
      return _scrollTop;
    },
    set scrollTop(v: number) {
      // Browser-accurate clamp to [0, scrollHeight - clientHeight].
      const max = Math.max(0, _scrollHeight - _clientHeight);
      _scrollTop = Math.max(0, Math.min(v, max));
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    _fire(type, ev) {
      listeners.get(type)?.forEach((fn) => fn(ev ?? {}));
    },
    _listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function gap(c: MockContainer): number {
  return c.scrollHeight - c.scrollTop - c.clientHeight;
}

// Controllable ResizeObserver.
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  cb: () => void;
  disconnected = false;
  constructor(cb: () => void) {
    this.cb = cb;
    MockResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  trigger() {
    if (!this.disconnected) this.cb();
  }
}
function latestRO(): MockResizeObserver {
  return MockResizeObserver.instances[MockResizeObserver.instances.length - 1]!;
}

// Controllable requestAnimationFrame queue.
let rafMap = new Map<number, () => void>();
let rafSeq = 0;
function flushRaf(levels = 1): void {
  for (let i = 0; i < levels; i++) {
    const entries = [...rafMap.values()];
    rafMap = new Map();
    entries.forEach((cb) => cb());
  }
}

beforeEach(() => {
  MockResizeObserver.instances = [];
  rafMap = new Map();
  rafSeq = 0;
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    const id = ++rafSeq;
    rafMap.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafMap.delete(id);
  });
  // Fake only setTimeout/clearTimeout so the reveal safety valve never fires on
  // its own; leave rAF to the explicit stub above.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(overrides: Partial<StickToBottomOptions> = {}) {
  const container = makeContainer();
  const contentRef = { current: {} as HTMLElement };
  const containerRef = { current: container as unknown as HTMLElement };
  const onReachTop = vi.fn();
  let props: StickToBottomOptions = {
    containerRef,
    contentRef,
    feedKey: 'agent-a',
    settling: false,
    isFetchingOlder: false,
    contentKey: 'k0',
    onReachTop,
    ...overrides,
  };
  const view = renderHook((p: StickToBottomOptions) => useStickToBottom(p), {
    initialProps: props,
  });
  // rerender merges a patch onto the tracked props (renderHook does not retain
  // prior props across rerenders).
  const rerender = (patch: Partial<StickToBottomOptions>) => {
    props = { ...props, ...patch };
    act(() => view.rerender(props));
  };
  return { container, onReachTop, view, rerender };
}

// Fire a mock DOM event inside act so any resulting setState is flushed.
function fire(container: MockContainer, type: string, ev?: unknown) {
  act(() => container._fire(type, ev));
}
function triggerRO() {
  act(() => latestRO().trigger());
}
function flush(levels = 1) {
  act(() => flushRaf(levels));
}
// Grow content (for a prepend the delta lands above; the RO only sees a total
// height delta either way), then let the observer react.
function growTo(container: MockContainer, height: number) {
  container.scrollHeight = height;
  triggerRO();
}

describe('useStickToBottom', () => {
  it('open: pins to bottom during initialPin, follows late layout growth, then reveals', () => {
    const { container, view, rerender } = setup({ settling: true });
    // Pinned to the bottom immediately (initialPin owns the scroll), still hidden.
    expect(gap(container)).toBe(0);
    expect(view.result.current.revealed).toBe(false);
    expect(view.result.current.stuck).toBe(false);

    // Late layout growth (a default-open fold animating, the live indicator
    // mounting) grows the bottom; initialPin follows it so the bottom holds.
    growTo(container, 1600);
    expect(gap(container)).toBe(0);

    // Feed stops settling -> reveal on the next frame and become stuck.
    rerender({ settling: false });
    flush(1);
    expect(view.result.current.revealed).toBe(true);
    expect(view.result.current.stuck).toBe(true);
    expect(gap(container)).toBe(0);
  });

  it('stuck: follows appended bottom-growth (new message / step)', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // settle -> stuck + revealed
    expect(view.result.current.stuck).toBe(true);
    expect(gap(container)).toBe(0);

    growTo(container, 1400);
    expect(gap(container)).toBe(0); // followed to the new bottom
    expect(container.scrollTop).toBe(1400 - 500);
  });

  it('reading: a scrolled-up reader is NOT yanked by bottom-growth', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck

    // User scrolls up: an upward wheel gesture, then a scroll that leaves bottom.
    fire(container, 'wheel', { deltaY: -120 });
    container.scrollTop = 100;
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(false); // reading

    // New message appends at the bottom.
    growTo(container, 1500);
    expect(container.scrollTop).toBe(100); // position untouched
    expect(gap(container)).toBe(1500 - 100 - 500); // gap grew; reader stays put
  });

  it('reading + prepend: preserves the viewport by the height delta', () => {
    const { container, view, rerender } = setup({ settling: false });
    flush(1); // stuck

    fire(container, 'wheel', { deltaY: -120 });
    container.scrollTop = 100;
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(false); // reading

    // Older page requested -> prepend flag arms.
    rerender({ isFetchingOlder: true });

    // Prepended content lands above the viewport: +300 total height.
    growTo(container, 1300);
    expect(container.scrollTop).toBe(400); // 100 + 300 delta -> viewport preserved

    // Fetch completes; flag disarms after a double rAF.
    rerender({ isFetchingOlder: false });
    flush(2);

    // A subsequent bottom-growth is now ordinary reading bottom-growth (no move).
    growTo(container, 1600);
    expect(container.scrollTop).toBe(400);
  });

  it('reading growth matrix: prepend restores; bottom-growth and non-prepend reflow do not', () => {
    const { container, view, rerender } = setup({ settling: false });
    flush(1);
    fire(container, 'wheel', { deltaY: -120 });
    container.scrollTop = 200;
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(false);

    // (1) reading + bottom-growth (new message) -> no scroll.
    growTo(container, 1200);
    expect(container.scrollTop).toBe(200);

    // (2) reading + non-prepend above-viewport reflow of already-loaded content.
    // Documented NON-GOAL: treated as bottom-growth, no correction. This cannot
    // arise in the Activity timeline today (reserved avatar dims, bundled fonts).
    growTo(container, 1300);
    expect(container.scrollTop).toBe(200);

    // (3) reading + prepend -> restore by delta.
    rerender({ isFetchingOlder: true });
    growTo(container, 1600); // +300 over 1300
    expect(container.scrollTop).toBe(500);
  });

  it('no-ResizeObserver fallback: keyed double-rAF follows the bottom while stuck', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { container, rerender } = setup({ settling: true });
    expect(gap(container)).toBe(0); // pinned in initialPin

    // Growth arrives with a new contentKey; no RO, so the fallback drives it.
    container.scrollHeight = 1800;
    rerender({ settling: true, contentKey: 'k1' });
    flush(2); // double rAF
    expect(gap(container)).toBe(0); // followed to the new bottom
  });

  // --- Touch gestures (the mobile "scroll up doesn't take" bug) --------------
  // touchstart arms intent ONCE per gesture; a drag's first scroll events land
  // inside BOTTOM_THRESHOLD where the re-stick branch consumes it. The fix
  // re-arms on any upward scrollTop movement while stuck, so slow drags and
  // momentum flicks (which deliver no touch events at all) flip to reading.

  it('touch: a slow upward drag flips to reading even after the threshold branch consumed the touchstart intent', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck; bottom = scrollTop 500 (1000 - 500)
    expect(view.result.current.stuck).toBe(true);

    fire(container, 'touchstart');
    // First drag tick stays inside the 80px re-stick zone: the else-branch
    // consumes the touchstart intent here (this is where the old code lost it).
    container.scrollTop = 460; // gap 40
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(true);

    // Drag continues past the threshold with NO further touch events.
    container.scrollTop = 380; // gap 120
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(false); // reading

    // Live-agent growth must not yank the reader back to the bottom.
    growTo(container, 1400);
    expect(container.scrollTop).toBe(380);
  });

  it('touch: a momentum fling (no touch events after lift-off) flips to reading and is not yanked', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck at bottom (scrollTop 500)

    fire(container, 'touchstart');
    container.scrollTop = 470; // gap 30 -> intent consumed by re-stick branch
    fire(container, 'scroll');
    // Finger lifts; momentum scrolling continues with scroll events only.
    container.scrollTop = 420; // gap 80, still inside threshold
    fire(container, 'scroll');
    container.scrollTop = 250; // gap 250, well past it
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(false); // reading

    growTo(container, 1600);
    expect(container.scrollTop).toBe(250); // reader stays put
  });

  it("the hook's own bottom pins never read as user intent", () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck
    // Growth pins to the new bottom (scrollTop increases); the browser fires a
    // scroll event for that write. It must not arm intent or leave stuck.
    growTo(container, 1400);
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(true);
    growTo(container, 1800);
    expect(gap(container)).toBe(0); // still following the bottom
  });

  it('onReachTop fires when the user scrolls near the top', () => {
    const { container, onReachTop } = setup({ settling: false });
    flush(1);
    container.scrollTop = 40; // < TOP_THRESHOLD
    fire(container, 'scroll');
    expect(onReachTop).toHaveBeenCalled();
  });

  it('feed switch: re-arms initialPin, re-hides, and does not leak scroll listeners', () => {
    const { container, view, rerender } = setup({ settling: false });
    flush(1);
    expect(view.result.current.stuck).toBe(true);
    expect(view.result.current.revealed).toBe(true);
    expect(container._listenerCount('scroll')).toBe(1);

    // Switch feeds.
    rerender({ feedKey: 'agent-b' });
    expect(view.result.current.stuck).toBe(false); // back to initialPin
    expect(view.result.current.revealed).toBe(false); // re-hidden
    // The scroll listener is mounted once (deps stable), never duplicated.
    expect(container._listenerCount('scroll')).toBe(1);

    // Settles again on the new feed.
    flush(1);
    expect(view.result.current.stuck).toBe(true);
    expect(view.result.current.revealed).toBe(true);

    // Unmount removes the listeners.
    view.unmount();
    expect(container._listenerCount('scroll')).toBe(0);
  });
});
