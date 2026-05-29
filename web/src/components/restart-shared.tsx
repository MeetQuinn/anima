import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { Check, Download, RefreshCw, X } from 'lucide-react';
import { fetchServerInfo } from '@/api/system';
import { queryKeys } from '@/lib/query-keys';

// ---------------------------------------------------------------------------
// Shared pieces for the v2 active-restart-drain + resume UI.
//
// Both the plain restart (RestartButton) and the managed upgrade
// (RuntimeUpgradeRow) now use ONE drain-to-quiescent + resume model:
//   - All idle      → execute immediately, no modal (nothing to interrupt).
//   - Agents working → a light, continuity-first confirm naming the running
//                      agents. Running only — queued items are NOT blockers in
//                      drain mode (the new worker picks them up untouched).
//   - On completion → an honest echo: "N agents resumed" fires ONLY when the
//                      restart actually drained + re-queued running agents.
//
// Copy is continuity-first by design: the fear of lost work comes from the word
// "interrupt", so we never use it — work is saved and continues.
// ---------------------------------------------------------------------------

/** Names the running set for the confirm copy: 1 → the agent's name, 2+ → "N agents". */
export function runningSubject(names: string[]): string {
  if (names.length === 1) return names[0] ?? 'An agent';
  return `${names.length} agents`;
}

// ---------------------------------------------------------------------------
// Busy confirm modal — parameterized for restart + upgrade
// ---------------------------------------------------------------------------

/**
 * Light confirm shown ONLY when agents are mid-task. Continuity-first: it leads
 * with the named running agents and reassures that their work is saved and
 * resumes — it never says "interrupt". Calm accent palette (not error-red) to
 * reinforce that this is safe. The upgrade variant adds the target-version line;
 * everything else is shared.
 */
export function BusyConfirmModal({
  kind,
  runningNames,
  target,
  onCancel,
  onConfirm,
}: {
  kind: 'restart' | 'upgrade';
  runningNames: string[];
  target?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Esc to cancel; click on backdrop also cancels. Confirm requires an explicit
  // button press.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const count = runningNames.length;
  const subject = runningSubject(runningNames);
  const verb = count === 1 ? 'is' : 'are';
  const action = kind === 'upgrade' ? 'update' : 'restart';
  const title = kind === 'upgrade' ? 'Update & restart now?' : 'Restart now?';
  const confirmLabel = kind === 'upgrade' ? 'Update & restart' : 'Restart now';
  const ConfirmIcon = kind === 'upgrade' ? Download : RefreshCw;

  // Portal to body: the trigger lives inside the ServerPanel drawer (an
  // absolutely-positioned, overflow-scrolling container), which traps a plain
  // `fixed inset-0` child to the ~330px drawer instead of the viewport. Rendering
  // into <body> guarantees the backdrop covers the whole app and the dialog
  // centers on the real viewport. (Caught in busy-path dogfood pass-2.)
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-page/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="busy-confirm-title"
        className="relative w-full max-w-xl rounded-sm border border-accent/40 bg-surface p-7 pl-8 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <span aria-hidden className="absolute left-0 top-4 bottom-4 w-px bg-accent" />
        <div id="busy-confirm-title" className="font-serif text-[17px] font-semibold text-text">
          {title}
        </div>
        <div className="font-serif mt-2 text-[15px] leading-relaxed text-text-muted">
          {/* Continuity-first: named, saved, resumes — never "interrupt". */}
          {subject} {verb} working. Their work is saved — after the {action} they&apos;ll continue
          right where they left off. Nothing is lost.
        </div>
        {kind === 'upgrade' && target && (
          <div className="mt-2.5 font-sans text-[12px] text-text-muted">
            Installs <span className="font-mono text-[12px] text-text">{target}</span> and restarts.
          </div>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="flex items-center gap-1.5 rounded-sm bg-accent px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <ConfirmIcon aria-hidden className="h-3.5 w-3.5" />
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-sm border border-border-soft px-3.5 py-2 text-[13px] text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Honest completion echo
// ---------------------------------------------------------------------------

// The lastRestart / operation result persists server-side until the next
// restart, so the echo MUST be freshness-gated on completedAt — otherwise it
// would re-show on every page load until the next restart. The window is wide
// enough to survive the post-restart reload (restart wall-time ~15-20s, then
// the page reloads and refetches) with comfortable margin.
export const RESTART_ECHO_FRESH_MS = 60_000;

/** The three result fields the UI needs to render the honest echo. */
export interface RestartEchoSignal {
  completedAt?: string;
  fallbackToIdle?: boolean;
  mode?: 'idle' | 'drain-active';
  resumedCount?: number;
  status?: 'blocked' | 'succeeded';
}

export type RestartEcho = { kind: 'resumed'; count: number } | { kind: 'restarted' } | null;

/**
 * The locked honesty rule (Nora 1780049911): "N agents resumed" fires ONLY on
 * the genuine drain-and-resume path — drain-active mode, did NOT fall back to
 * idle-wait, and at least one running item was re-queued. On the fallback path
 * (drain timeout → wait-for-idle, nothing interrupted) NOTHING resumed, so it
 * must show plain "restarted" — never a false resume claim. Returns null once
 * the event ages out of the freshness window (or if there's no completion).
 *
 * Date.now() is called inside the function body so callers don't trigger
 * react-hooks/purity warnings by calling it during render.
 */
export function restartEcho(signal: RestartEchoSignal | undefined): RestartEcho {
  if (!signal?.completedAt) return null;
  if (signal.status === 'blocked') return null;
  const completed = Date.parse(signal.completedAt);
  if (!Number.isFinite(completed) || Date.now() - completed > RESTART_ECHO_FRESH_MS) return null;
  if (signal.mode === 'drain-active' && !signal.fallbackToIdle && (signal.resumedCount ?? 0) > 0) {
    return { kind: 'resumed', count: signal.resumedCount ?? 0 };
  }
  return { kind: 'restarted' };
}

/** "1 agent resumed" / "3 agents resumed" */
export function resumedText(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'} resumed`;
}

// ---------------------------------------------------------------------------
// App-level echo toast (plain restart)
// ---------------------------------------------------------------------------

const TOAST_DWELL_MS = 6_000;
const TOAST_ACK_KEY = 'restart-echo-ack';

/**
 * Transient confirmation after a plain restart. Mounted once at the app root so
 * it survives the post-restart page reload (which closes the Server panel) —
 * the panel can't host this echo because it isn't open when the page comes
 * back. Reads serverInfo.lastRestart, shows the honest echo briefly, then
 * acks the event (per-tab) so a manual refresh inside the fresh window doesn't
 * re-pop it. The upgrade echo rides its own version-flip surface (inline in the
 * upgrade row), not this toast.
 */
export function RestartEchoToast() {
  const { data: info } = useQuery({
    queryKey: queryKeys.serverInfo(),
    queryFn: fetchServerInfo,
    staleTime: 60_000,
  });
  const completedAt = info?.lastRestart?.completedAt;
  const echo = useMemo(
    () => restartEcho(info?.lastRestart),
    // completedAt is the only field that changes per restart event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [completedAt],
  );

  const [visible, setVisible] = useState(false);
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    if (!echo || !completedAt) return;
    if (shownFor.current === completedAt) return; // already handled this event
    shownFor.current = completedAt;
    // Don't re-pop the same restart on a manual refresh within the fresh window.
    try {
      if (sessionStorage.getItem(TOAST_ACK_KEY) === completedAt) return;
    } catch {
      /* sessionStorage unavailable — fall through and show once */
    }
    setTimeout(() => setVisible(true), 0);
    const remaining = RESTART_ECHO_FRESH_MS - (Date.now() - Date.parse(completedAt));
    const dwell = Math.max(1_500, Math.min(TOAST_DWELL_MS, remaining));
    const timer = setTimeout(() => {
      setVisible(false);
      try {
        sessionStorage.setItem(TOAST_ACK_KEY, completedAt);
      } catch {
        /* ignore */
      }
    }, dwell);
    return () => clearTimeout(timer);
  }, [echo, completedAt]);

  function dismiss() {
    setVisible(false);
    if (completedAt) {
      try {
        sessionStorage.setItem(TOAST_ACK_KEY, completedAt);
      } catch {
        /* ignore */
      }
    }
  }

  if (!visible || !echo) return null;

  const text = echo.kind === 'resumed' ? resumedText(echo.count) : 'Services restarted';

  return createPortal(
    <div
      className="pointer-events-none fixed bottom-4 left-4 z-[70]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex items-center gap-2 rounded-sm border border-border-soft bg-surface px-3.5 py-2.5 shadow-deep"
      >
        <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-health-ok" />
        <span className="font-serif text-[13px] text-text">{text}</span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="ml-1 flex h-5 w-5 items-center justify-center rounded-sm text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <X aria-hidden className="h-3 w-3" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
