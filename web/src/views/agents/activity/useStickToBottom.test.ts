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
  // The viewport is settable: the timeline is `flex-1` under a column whose other
  // children (status summary, banners, error bar) mount late, which changes how
  // much of the content fits without changing the content itself.
  let _clientHeight = clientHeight;
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
    set clientHeight(v: number) {
      _clientHeight = v;
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

// Controllable ResizeObserver. It records WHAT it was asked to observe and only
// notifies for those elements, exactly as a browser does. A stub that fires for
// any target is reachable without the wiring under test, so deleting an
// `ro.observe(...)` call would still pass and the harness would prove nothing.
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  cb: () => void;
  disconnected = false;
  targets = new Set<unknown>();
  constructor(cb: () => void) {
    this.cb = cb;
    MockResizeObserver.instances.push(this);
  }
  observe(target: unknown) {
    this.targets.add(target);
  }
  unobserve(target: unknown) {
    this.targets.delete(target);
  }
  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }
  triggerFor(target: unknown) {
    if (!this.disconnected && this.targets.has(target)) this.cb();
  }
  observes(target: unknown) {
    return this.targets.has(target);
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

// The two elements the current setup() handed the hook, so the growth/resize
// helpers can name the exact target the browser would notify for.
let currentContent: HTMLElement | null = null;
let currentContainer: HTMLElement | null = null;

beforeEach(() => {
  MockResizeObserver.instances = [];
  currentContent = null;
  currentContainer = null;
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
  const contentEl = {} as HTMLElement;
  const containerEl = container as unknown as HTMLElement;
  const contentRef = { current: contentEl };
  const containerRef = { current: containerEl };
  currentContent = contentEl;
  currentContainer = containerEl;
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
  return { container, containerEl, contentEl, onReachTop, view, rerender };
}

// Fire a mock DOM event inside act so any resulting setState is flushed.
function fire(container: MockContainer, type: string, ev?: unknown) {
  act(() => container._fire(type, ev));
}
function flush(levels = 1) {
  act(() => flushRaf(levels));
}
// Grow content (for a prepend the delta lands above; the RO only sees a total
// height delta either way), then let the observer react. The browser notifies
// for the CONTENT wrapper here, so this fires nothing unless it is observed.
function growTo(container: MockContainer, height: number) {
  container.scrollHeight = height;
  act(() => latestRO().triggerFor(currentContent));
}
// Change the viewport without touching the content: something above the timeline
// mounted, unmounted or resized. The browser notifies for the CONTAINER, so this
// fires nothing unless the container itself is observed.
function resizeViewportBy(container: MockContainer, px: number) {
  container.clientHeight = container.clientHeight + px;
  act(() => latestRO().triggerFor(currentContainer));
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

  // --- Viewport change with no content change --------------------------------
  // The reported "activity tab 每次刚打开都会抖几下才稳定": the timeline is `flex-1`
  // in a column that also holds the status summary, the onboarding banners and
  // the error bar. ActivityStatusSummary renders null until the agent status
  // query resolves (index.tsx `if (!status) return null`), then mounts ABOVE the
  // scroll container. The content height does not change at all — only how much
  // of it fits — so a content-only observer sees nothing and the pinned bottom
  // slides away by exactly the height that appeared.

  it('observes the scroll container itself, not only the content wrapper', () => {
    // The catching mutation for the three tests below is "delete ro.observe(el)";
    // assert the wiring directly so it cannot hide behind a passing assertion.
    const { containerEl, contentEl } = setup({ settling: false });
    expect(latestRO().observes(contentEl)).toBe(true);
    expect(latestRO().observes(containerEl)).toBe(true);
  });

  it('stuck: a bar mounting above the timeline shrinks the viewport and the bottom is re-pinned', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck + revealed, pinned at the bottom
    expect(gap(container)).toBe(0);

    resizeViewportBy(container, -44); // status summary mounts above

    expect(view.result.current.stuck).toBe(true);
    expect(gap(container)).toBe(0);
  });

  it('stuck: a bar unmounting (viewport grows) re-pins as well', () => {
    const { container, view } = setup({ settling: false });
    flush(1);
    resizeViewportBy(container, -44);
    expect(gap(container)).toBe(0);

    resizeViewportBy(container, 44); // the banner is dismissed again

    expect(view.result.current.stuck).toBe(true);
    expect(gap(container)).toBe(0);
  });

  it('reading: a viewport change never yanks a scrolled-up reader', () => {
    const { container, view } = setup({ settling: false });
    flush(1);
    fire(container, 'wheel', { deltaY: -120 });
    container.scrollTop = 100;
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(false); // reading

    resizeViewportBy(container, -44);

    expect(container.scrollTop).toBe(100); // position untouched
    expect(view.result.current.stuck).toBe(false);
  });

  it('harness liveness: the observer stub only notifies for elements it observes', () => {
    // If triggerFor() fired unconditionally, every growth and viewport test in
    // this file would pass with the corresponding ro.observe() deleted.
    const { container } = setup({ settling: false });
    flush(1);
    const stranger = {} as HTMLElement;

    container.clientHeight = container.clientHeight - 44;
    act(() => latestRO().triggerFor(stranger));

    expect(latestRO().observes(stranger)).toBe(false);
    expect(gap(container)).toBe(44); // uncorrected: no notification was delivered
  });

  it('reveal safety valve: a feed that never settles is still revealed at 800ms', () => {
    // setTimeout is faked so the valve never fires during the tests above; this
    // one drives it on purpose, since it is the only path that reveals without
    // an observed stable bottom.
    const { view } = setup({ settling: true });
    expect(view.result.current.revealed).toBe(false);
    act(() => vi.advanceTimersByTime(799));
    expect(view.result.current.revealed).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(view.result.current.revealed).toBe(true);
    expect(view.result.current.stuck).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gesture window: while a user gesture is plausibly in progress, bottom pins
// are deferred, never written. Without it, a live agent's near-continuous
// growth ticks re-pin the bottom while the user is still inside the 80px
// re-stick zone — resetting the distance they must escape (and on iOS also
// cancelling the native pan gesture), i.e. "can't scroll up at all on mobile
// while the agent works".
// ---------------------------------------------------------------------------
describe('useStickToBottom gesture window', () => {
  function settle(ms = 250) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it('growth landing mid-drag is deferred, and the drag escapes to reading', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck; scrollHeight 1000, clientHeight 500, scrollTop 500
    expect(view.result.current.stuck).toBe(true);

    fire(container, 'touchstart');
    container.scrollTop = 460; // gap 40, inside the re-stick zone
    fire(container, 'scroll');
    // Live agent output lands before the finger covers 80px.
    growTo(container, 1100);
    expect(container.scrollTop).toBe(460); // NOT yanked to 600
    expect(view.result.current.stuck).toBe(true);

    // The drag continues; growth widened the gap, so this crosses the threshold.
    container.scrollTop = 420; // gap 180
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(false); // reading

    growTo(container, 1300);
    expect(container.scrollTop).toBe(420); // reader stays put
  });

  it('a deferred pin is applied at gesture settle when still near the bottom', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck at 500

    fire(container, 'touchstart');
    container.scrollTop = 460; // gap 40
    fire(container, 'scroll');
    growTo(container, 1020); // deferred; gap now 60, still near bottom
    expect(container.scrollTop).toBe(460);
    fire(container, 'touchend');
    settle();
    expect(container.scrollTop).toBe(520); // pinned to the new bottom
    expect(view.result.current.stuck).toBe(true);
  });

  it('an escape that only settles after lift-off drops to reading, never yanks', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck at 500

    fire(container, 'touchstart');
    container.scrollTop = 460; // gap 40 — the user DID move upward
    fire(container, 'scroll');
    growTo(container, 1100); // deferred; gap now 140, beyond the threshold
    fire(container, 'touchend');
    settle();
    // The user moved upward and ended beyond the threshold: reading, no pin.
    expect(container.scrollTop).toBe(460);
    expect(view.result.current.stuck).toBe(false);
  });

  it('tap during streaming: growth is deferred, then pinned (no upward move)', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck at 500

    fire(container, 'touchstart');
    fire(container, 'touchend'); // a tap, no scroll at all
    growTo(container, 1200); // lands inside the window
    expect(container.scrollTop).toBe(500); // deferred while the window is open
    settle();
    // The user never moved upward: still following, even though the gap (200)
    // exceeded the threshold purely from growth below.
    expect(container.scrollTop).toBe(700);
    expect(view.result.current.stuck).toBe(true);
  });

  it('a held finger keeps the window open past the settle timeout', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck at 500

    fire(container, 'touchstart');
    container.scrollTop = 460;
    fire(container, 'scroll');
    growTo(container, 1020); // deferred
    settle(); // timeout fires while the finger is still down -> stays open
    expect(container.scrollTop).toBe(460); // still not pinned
    fire(container, 'touchend');
    settle();
    expect(container.scrollTop).toBe(520); // gap 60 <= threshold -> pinned
    expect(view.result.current.stuck).toBe(true);
  });

  it('wheel-up inside the threshold defers growth; continued wheel escapes', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck at 500

    fire(container, 'wheel', { deltaY: -100 });
    container.scrollTop = 470; // gap 30
    fire(container, 'scroll');
    growTo(container, 1100); // deferred
    expect(container.scrollTop).toBe(470); // NOT yanked
    container.scrollTop = 400; // gap 200
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(false); // reading

    growTo(container, 1300);
    expect(container.scrollTop).toBe(400);
  });

  it('scroll-only upward movement (scrollbar, keyboard) arms intent but never opens the window', () => {
    // Layout can fake a scrollTop decrease (fold-collapse clamp + same-frame
    // regrowth), so bare scroll movement must not defer pins. A scrollbar drag
    // still escapes: one event that crosses the threshold flips to reading.
    const { container, view } = setup({ settling: false });
    flush(1); // stuck at 500

    container.scrollTop = 460; // upward movement with no touch/wheel event
    fire(container, 'scroll');
    growTo(container, 1100); // NOT deferred: pins immediately (no real input seen)
    expect(container.scrollTop).toBe(600);
    fire(container, 'scroll');
    container.scrollTop = 400; // one big jump crosses the threshold
    fire(container, 'scroll');
    expect(view.result.current.stuck).toBe(false); // reading

    growTo(container, 1300);
    expect(container.scrollTop).toBe(400); // reader stays put
  });

  it('a viewport change mid-touch is deferred like growth', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck at 500

    fire(container, 'touchstart');
    container.scrollTop = 460; // gap 40
    fire(container, 'scroll');
    resizeViewportBy(container, -20); // banner mounts while the finger is down
    expect(container.scrollTop).toBe(460); // not written into the gesture
    fire(container, 'touchend');
    settle();
    expect(container.scrollTop).toBe(520); // gap 60 <= threshold -> pinned
    expect(view.result.current.stuck).toBe(true);
  });

  it('a content-shrink clamp (fold collapse) is not user input; following continues', () => {
    const { container, view } = setup({ settling: false });
    flush(1); // stuck at 500

    // The live fold auto-collapses: content shrinks and the browser clamps
    // scrollTop, firing a scroll event that reads as a decrease landing exactly
    // at the bottom (gap 0). That clamp must not open the gesture window.
    container.scrollHeight = 900;
    container.scrollTop = 999999; // mock setter clamps to 400
    fire(container, 'scroll');
    act(() => latestRO().triggerFor(currentContent)); // RO sees the shrink

    // The next growth must follow IMMEDIATELY (no deferral, no reading flip).
    growTo(container, 1000);
    expect(container.scrollTop).toBe(500);
    expect(view.result.current.stuck).toBe(true);
  });

  it('growth with NO gesture in progress still pins immediately', () => {
    const { container } = setup({ settling: false });
    flush(1); // stuck at 500
    growTo(container, 1400);
    expect(container.scrollTop).toBe(900); // synchronous follow, no deferral
  });

  it('feed switch mid-gesture resets the window; no deferred pin leaks across', () => {
    const { container, view, rerender } = setup({ settling: false });
    flush(1); // stuck at 500

    fire(container, 'touchstart');
    container.scrollTop = 460;
    fire(container, 'scroll');
    growTo(container, 1100); // deferred under agent-a's gesture
    rerender({ feedKey: 'agent-b' }); // switch pins to bottom + resets
    expect(container.scrollTop).toBe(600);
    settle(); // the stale gesture timer must be gone
    expect(container.scrollTop).toBe(600); // no late close-time write
    flush(1);
    expect(view.result.current.stuck).toBe(true);
  });
});
