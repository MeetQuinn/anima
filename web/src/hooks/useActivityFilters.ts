import { useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router-dom';

// Shared hook for the activity-view lens and filter state.
//
// Lens ('activity' | 'messages'):
//   - Persisted in localStorage so the user's preference survives navigation.
//   - Default = 'activity' on first visit.
//   - 'activity' = curated activity stream (meaningful actions by default; full
//     firehose when Show all steps is on). 'messages' = comms-only view.
//   - Legacy value 'full' (from the short-lived binary model) is treated as
//     'activity' on read.
//
// Show all steps (only meaningful in activity lens):
//   - Persisted in localStorage. Default = false (curated view).
//   - OFF = curated (isNarrativeStep filter + message rows).
//   - ON  = full firehose (all tool calls, lifecycle, subagent events).
//
// Direction sub-filter (only meaningful in messages lens):
//   - URL param `dir=in|out`; absent = 'all'. Not persisted.
//
// Failed-only filter:
//   - URL param `failed=1`. Only surfaced in activity lens.

const LENS_STORAGE_KEY = 'anima-activity-lens';
const SHOW_ALL_STORAGE_KEY = 'anima-activity-show-all-steps';

export type ActivityLens = 'activity' | 'messages';
export type ActivityDir = 'all' | 'in' | 'out';

// ---------------------------------------------------------------------------
// Module-level reactive stores — useSyncExternalStore pattern.
// Multiple components (AgentHeader + Activity) call useActivityFilters() and
// all stay in sync when a value changes.
// ---------------------------------------------------------------------------

type Listener = () => void;

// --- lens store ---

const lensListeners = new Set<Listener>();

function readStoredLens(): ActivityLens {
  try {
    const stored = localStorage.getItem(LENS_STORAGE_KEY);
    // 'full' was the legacy value from the short-lived binary model — treat as 'activity'.
    if (stored === 'messages') return 'messages';
    if (stored === 'activity' || stored === 'full') return 'activity';
  } catch {
    // localStorage unavailable
  }
  return 'activity';
}

let _lens: ActivityLens = readStoredLens();

// Transient, NON-persisted override. The post-onboarding first landing forces the
// activity view so the "agent is alive" payoff is what greets a fresh connect —
// but the user's stored steady-state preference must be left untouched (day-to-day
// default stays conversation / their last choice). So this lives only in memory:
// it survives navigation within the session, is gone on reload, and any explicit
// lens choice (setLensGlobal) drops it and persists the real preference.
let _lensOverride: ActivityLens | null = null;

function getLens(): ActivityLens { return _lensOverride ?? _lens; }

function setLensGlobal(v: ActivityLens): void {
  // An explicit user choice clears the transient override and becomes the
  // persisted preference.
  _lensOverride = null;
  _lens = v;
  try { localStorage.setItem(LENS_STORAGE_KEY, v); } catch { /* ignore */ }
  lensListeners.forEach((l) => l());
}

/** Force a lens for this session without persisting it (first-landing only). */
export function applyLensOverride(v: ActivityLens): void {
  if (_lensOverride === v) return;
  _lensOverride = v;
  lensListeners.forEach((l) => l());
}

/** Drop any transient override so the stored preference applies again. */
export function clearLensOverride(): void {
  if (_lensOverride === null) return;
  _lensOverride = null;
  lensListeners.forEach((l) => l());
}

function subscribeLens(listener: Listener): () => void {
  lensListeners.add(listener);
  return () => lensListeners.delete(listener);
}

// --- showAllSteps store ---

const showAllListeners = new Set<Listener>();

function readStoredShowAll(): boolean {
  try {
    return localStorage.getItem(SHOW_ALL_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

let _showAll: boolean = readStoredShowAll();

function getShowAll(): boolean { return _showAll; }

function setShowAllGlobal(v: boolean): void {
  _showAll = v;
  try { localStorage.setItem(SHOW_ALL_STORAGE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  showAllListeners.forEach((l) => l());
}

function subscribeShowAll(listener: Listener): () => void {
  showAllListeners.add(listener);
  return () => showAllListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface ActivityFilters {
  lens: ActivityLens;
  dir: ActivityDir;
  failedOnly: boolean;
  showAllSteps: boolean;
  setLens: (v: ActivityLens) => void;
  setDir: (v: ActivityDir) => void;
  setFailedOnly: (v: boolean) => void;
  setShowAllSteps: (v: boolean) => void;
}

export function useActivityFilters(): ActivityFilters {
  const [searchParams, setSearchParams] = useSearchParams();

  const lens = useSyncExternalStore(subscribeLens, getLens, readStoredLens);
  const showAllSteps = useSyncExternalStore(subscribeShowAll, getShowAll, readStoredShowAll);

  // Direction sub-filter — URL param only.
  const rawDir = searchParams.get('dir');
  const dir: ActivityDir =
    rawDir === 'in' ? 'in' : rawDir === 'out' ? 'out' : 'all';

  function setDir(v: ActivityDir) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'all') next.delete('dir');
        else next.set('dir', v);
        return next;
      },
      { replace: true },
    );
  }

  // Failed-only — URL param only.
  const failedOnly = searchParams.get('failed') === '1';

  function setFailedOnly(v: boolean) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v) next.set('failed', '1');
        else next.delete('failed');
        return next;
      },
      { replace: true },
    );
  }

  return {
    lens,
    dir,
    failedOnly,
    showAllSteps,
    setLens: setLensGlobal,
    setDir,
    setFailedOnly,
    setShowAllSteps: setShowAllGlobal,
  };
}
