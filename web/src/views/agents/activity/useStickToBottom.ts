import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

// ---------------------------------------------------------------------------
// useStickToBottom — the single owner of the Activity timeline's scroll
// position. It replaces ~8 independent effects that each wrote `scrollTop` and
// raced at the edges (the recurring "jumps / doesn't reach bottom" bugs).
//
// Model: three mutually-exclusive MODES, never scattered booleans.
//   • initialPin — the feed identity just changed; the hook owns the bottom and
//     keeps re-pinning through late layout growth (a default-open fold's
//     animation, the live indicator mounting) until the bottom is stable, then
//     it reveals the timeline and becomes `stuck`. The timeline renders hidden
//     (opacity-0, still laid out) until `revealed`, so the settle is never seen.
//   • stuck — the user is at/near the bottom; content growth follows the bottom.
//   • reading — the user deliberately scrolled up; growth never yanks them.
//
// One writer: a ResizeObserver on the content wrapper is the ONLY thing that
// reacts to content growth. It branches on the current mode:
//   stuck / initialPin       -> scrollTop = scrollHeight   (follow bottom)
//   reading + prepend active -> scrollTop += delta          (preserve viewport)
//   reading + bottom growth  -> nothing                     (never yank)
//
// Determinism: the container uses `overflow-anchor: none` so the browser never
// adjusts scrollTop on content change. Every adjustment is hook-owned, which
// makes the whole behavior reviewable and unit-testable with a mocked RO. Top-
// growth vs bottom-growth is disambiguated by an explicit prepend flag driven by
// `isFetchingOlder` (not by measuring viewport offsets).
//
// Non-goal (documented, intentional): a NON-prepend above-viewport reflow of
// already-loaded content while `reading` is treated as bottom-growth (no scroll
// correction). This cannot arise in the Activity timeline today — avatars carry
// reserved `h-9 w-9` dimensions (image load does not reflow) and fonts are
// bundled/preloaded (no late font swap) — so there is no post-layout above-
// viewport reflow source. If one is ever introduced, the fix is a measured
// scroll anchor for reading mode; see the RO callback.
// ---------------------------------------------------------------------------

type Mode = 'initialPin' | 'stuck' | 'reading';

// px within the bottom that still counts as "at bottom" (re-stick threshold).
const BOTTOM_THRESHOLD = 80;
// px within the top that triggers an older-page load.
const TOP_THRESHOLD = 100;
// Hard ceiling on how long the timeline stays hidden during initialPin, even if
// `settling` never resolves (an agent with no data, a stalled fetch). Safety
// valve only — the normal reveal is tied to observed bottom stability.
const REVEAL_SAFETY_MS = 800;

export interface StickToBottomOptions {
  /** The scrolling element. */
  containerRef: RefObject<HTMLElement | null>;
  /** A static wrapper around the scrolling content, observed for size changes. */
  contentRef: RefObject<HTMLElement | null>;
  /** Feed identity (e.g. agentId). A change re-arms initialPin and re-hides. */
  feedKey: string | null;
  /** True while the newest rows / coverage are still arriving after a (re)load. */
  settling: boolean;
  /** True while an older-page (prepend) fetch is in flight. */
  isFetchingOlder: boolean;
  /**
   * A string that changes whenever loaded content grows (page count, newest
   * message key, live item, latest activity). Only consumed on the no-
   * ResizeObserver fallback path; with RO present the observer drives growth.
   */
  contentKey: string;
  /** Called when the user scrolls near the top — the parent loads older history. */
  onReachTop: () => void;
}

export interface StickToBottomState {
  /** True when following the bottom (mode `stuck`). */
  stuck: boolean;
  /** True once the initial settle has reached a stable bottom and faded in. */
  revealed: boolean;
}

function bottomGap(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function scrollToBottom(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}

export function useStickToBottom({
  containerRef,
  contentRef,
  feedKey,
  settling,
  isFetchingOlder,
  contentKey,
  onReachTop,
}: StickToBottomOptions): StickToBottomState {
  const [mode, setModeState] = useState<Mode>('initialPin');
  const [revealed, setRevealedState] = useState(false);

  // Mirror the reactive values in refs so the once-mounted listeners and the RO
  // callback always read the latest without re-subscribing.
  const modeRef = useRef<Mode>('initialPin');
  const revealedRef = useRef(false);
  const setMode = useCallback((m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);
  const setRevealed = useCallback((v: boolean) => {
    revealedRef.current = v;
    setRevealedState(v);
  }, []);

  // Last observed scroll height, so a growth delta can be computed.
  const prevHeightRef = useRef(0);
  // A prepend (older page) is in flight; the next top-growth must be preserved.
  const prependPendingRef = useRef(false);
  // The user made a deliberate upward gesture; the next scroll that leaves the
  // bottom flips to `reading`. Gated on gesture (not a derived not-at-bottom)
  // because a prepend momentarily reads as not-at-bottom before the RO re-pins.
  const userIntentRef = useRef(false);
  // Whether a real ResizeObserver is driving growth (else the fallback runs).
  const roActiveRef = useRef(false);

  // Re-hide + re-arm the instant the feed identity changes, during render (the
  // documented "adjust state when a prop changes" pattern — the guard is state,
  // not a ref, so it survives a discarded concurrent render) so the previous
  // feed's timeline never flashes at opacity-100 before an effect re-hides it.
  // Only STATE is touched here; the mirror refs + DOM pin are reset in the feed-
  // key effect (which runs before the reveal effect, so no read sees stale mode).
  const [prevFeedKey, setPrevFeedKey] = useState(feedKey);
  if (feedKey !== prevFeedKey) {
    setPrevFeedKey(feedKey);
    setModeState('initialPin');
    setRevealedState(false);
  }

  // Always call the freshest onReachTop from the once-mounted scroll listener.
  const onReachTopRef = useRef(onReachTop);
  useEffect(() => {
    onReachTopRef.current = onReachTop;
  });

  // The single growth writer. Shared by the RO and the no-RO fallback.
  const applyGrowth = useCallback(
    (node: HTMLElement, delta: number) => {
      const m = modeRef.current;
      if (m === 'stuck' || m === 'initialPin') {
        scrollToBottom(node);
        return;
      }
      // reading: preserve the viewport on a prepend (top-growth); otherwise leave
      // the position untouched so bottom-growth never yanks a scrolled-up reader.
      if (prependPendingRef.current && delta > 0) {
        node.scrollTop += delta;
      }
      // reading + non-prepend growth: no correction (see the file header's
      // documented non-goal). Treated as bottom-growth.
    },
    [],
  );

  // --- Scroll / gesture listeners: mounted once, read state via refs. --------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      const gap = bottomGap(el);
      const m = modeRef.current;
      if (m === 'reading') {
        // Returned to the bottom -> resume following.
        if (gap <= BOTTOM_THRESHOLD) {
          userIntentRef.current = false;
          setMode('stuck');
        }
      } else {
        // stuck / initialPin: only a deliberate gesture that actually left the
        // bottom drops to reading. Programmatic scrolls carry no user intent.
        if (userIntentRef.current && gap > BOTTOM_THRESHOLD) {
          userIntentRef.current = false;
          setMode('reading');
          // A gesture during the hidden initialPin settle means the user is
          // taking over; reveal so they aren't scrolling a blank panel.
          if (!revealedRef.current) setRevealed(true);
        } else if (gap <= BOTTOM_THRESHOLD) {
          // Still (or again) at the bottom; the gesture didn't leave it.
          userIntentRef.current = false;
        }
      }
      if (el.scrollTop < TOP_THRESHOLD) onReachTopRef.current();
    };

    // A wheel-up or any touch is the user taking over. Wheel-down toward the
    // bottom is not an intent to leave, so only negative deltaY arms intent.
    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) userIntentRef.current = true;
    };
    const handleTouchStart = () => {
      userIntentRef.current = true;
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    el.addEventListener('wheel', handleWheel, { passive: true });
    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      el.removeEventListener('wheel', handleWheel);
      el.removeEventListener('touchstart', handleTouchStart);
    };
    // Mounted once; refs carry the latest state. setMode/setRevealed are stable.
  }, [containerRef, setMode, setRevealed]);

  // --- ResizeObserver: the single growth writer. ----------------------------
  useEffect(() => {
    const content = contentRef.current;
    const el = containerRef.current;
    if (!content || !el) return;
    prevHeightRef.current = el.scrollHeight;
    if (typeof ResizeObserver === 'undefined') {
      roActiveRef.current = false;
      return;
    }
    roActiveRef.current = true;
    const ro = new ResizeObserver(() => {
      const node = containerRef.current;
      if (!node) return;
      const newHeight = node.scrollHeight;
      const delta = newHeight - prevHeightRef.current;
      prevHeightRef.current = newHeight;
      if (delta === 0) return;
      applyGrowth(node, delta);
    });
    ro.observe(content);
    return () => {
      ro.disconnect();
      roActiveRef.current = false;
    };
  }, [containerRef, contentRef, applyGrowth]);

  // --- No-RO fallback: a keyed double-rAF running the same growth branch. ----
  // Runs only when ResizeObserver is unavailable. `contentKey` changes whenever
  // loaded content grows; two rAFs let the new rows lay out before we measure.
  useEffect(() => {
    if (roActiveRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const node = containerRef.current;
        if (!node) return;
        const delta = node.scrollHeight - prevHeightRef.current;
        prevHeightRef.current = node.scrollHeight;
        if (delta !== 0) applyGrowth(node, delta);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [contentKey, containerRef, applyGrowth]);

  // --- Prepend flag: cover the whole request -> layout -> restore window. ----
  // Arm the instant an older-page fetch is requested; keep it armed until a
  // double-rAF AFTER the fetch clears, so the final prepended chunk's RO delta
  // is still classified as top-growth and restores position. It must never drop
  // on network completion before layout/RO fires.
  useEffect(() => {
    if (isFetchingOlder) {
      prependPendingRef.current = true;
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        prependPendingRef.current = false;
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isFetchingOlder]);

  // --- Feed identity change: re-arm the mirror refs + pin to the bottom. -----
  // The reactive re-arm (mode/revealed state) happens during render above; the
  // mirror refs and the DOM pin (scrollTop) are reset here (an effect, so no ref
  // is mutated during render). This runs before the reveal effect below, so the
  // reveal never reads a stale mode.
  useEffect(() => {
    modeRef.current = 'initialPin';
    revealedRef.current = false;
    userIntentRef.current = false;
    prependPendingRef.current = false;
    const el = containerRef.current;
    prevHeightRef.current = el ? el.scrollHeight : 0;
    if (el) scrollToBottom(el);
  }, [feedKey, containerRef]);

  // --- Reveal: tied to observed bottom stability. ---------------------------
  // While in initialPin, once the feed stops settling, pin once more and reveal
  // on the next frame (so the final pin lands before the fade-in), becoming
  // `stuck`. The RO keeps following late growth up until this flips the mode.
  useEffect(() => {
    if (modeRef.current !== 'initialPin' || revealedRef.current) return;
    if (settling) return;
    const el = containerRef.current;
    if (el) scrollToBottom(el);
    const id = requestAnimationFrame(() => {
      const node = containerRef.current;
      if (node) scrollToBottom(node);
      setMode('stuck');
      setRevealed(true);
    });
    return () => cancelAnimationFrame(id);
    // feedKey re-arms initialPin; re-run so a feed that lands already-settled
    // still reveals. mode/revealed are read via refs (kept in deps-free refs).
  }, [settling, feedKey, containerRef, setMode, setRevealed]);

  // --- Reveal safety valve: never stay hidden past REVEAL_SAFETY_MS. --------
  useEffect(() => {
    const t = setTimeout(() => {
      if (modeRef.current === 'initialPin') {
        setMode('stuck');
        setRevealed(true);
      }
    }, REVEAL_SAFETY_MS);
    return () => clearTimeout(t);
  }, [feedKey, setMode, setRevealed]);

  return { stuck: mode === 'stuck', revealed };
}
