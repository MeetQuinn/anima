import { useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router-dom';

// Shared hook for the Activity-view filter state.
//
// The Activity tab is one Slack-style timeline (the conversation) plus a single
// "Show tool steps" toggle (iris-locked spec `795d974`). There is no lens: the
// conversation is always primary; the toggle interleaves curated tool steps /
// memory-coherence / processing signals as subordinate rows.
//
// Show tool steps:
//   - Persisted in localStorage. Default = false (clean conversation).
//   - OFF = conversation only (messages / files / reactions).
//   - ON  = curated steps (isNarrativeStep) interleaved chronologically.
//   - Migrated from the retired 'anima-activity-show-all-steps' pref: a user who
//     had the old firehose on wanted steps visible, so it maps to ON.
//
// Direction sub-filter (applies to the conversation rows):
//   - URL param `dir=in|out`; absent = 'all'. Not persisted.
//
// Failed-only filter:
//   - URL param `failed=1`. Implies steps are shown (failure rows are steps).

const SHOW_STEPS_STORAGE_KEY = 'anima-activity-show-tool-steps';
const LEGACY_SHOW_ALL_STORAGE_KEY = 'anima-activity-show-all-steps';

export type ActivityDir = 'all' | 'in' | 'out';

// ---------------------------------------------------------------------------
// Module-level reactive store — useSyncExternalStore pattern.
// AgentHeader + Activity both call useActivityFilters() and stay in sync when
// the toggle changes.
// ---------------------------------------------------------------------------

type Listener = () => void;

const showStepsListeners = new Set<Listener>();

function readStoredShowSteps(): boolean {
  try {
    const stored = localStorage.getItem(SHOW_STEPS_STORAGE_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
    // One-time migration: a user who had the old "show all steps" firehose on
    // wanted the agent's steps visible — carry that intent onto the new toggle.
    if (localStorage.getItem(LEGACY_SHOW_ALL_STORAGE_KEY) === '1') return true;
  } catch {
    // localStorage unavailable
  }
  return false;
}

let _showSteps: boolean = readStoredShowSteps();

function getShowSteps(): boolean {
  return _showSteps;
}

function setShowStepsGlobal(v: boolean): void {
  _showSteps = v;
  try {
    localStorage.setItem(SHOW_STEPS_STORAGE_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
  showStepsListeners.forEach((l) => l());
}

function subscribeShowSteps(listener: Listener): () => void {
  showStepsListeners.add(listener);
  return () => showStepsListeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface ActivityFilters {
  dir: ActivityDir;
  failedOnly: boolean;
  showToolSteps: boolean;
  setDir: (v: ActivityDir) => void;
  setFailedOnly: (v: boolean) => void;
  setShowToolSteps: (v: boolean) => void;
}

export function useActivityFilters(): ActivityFilters {
  const [searchParams, setSearchParams] = useSearchParams();

  const storedShowSteps = useSyncExternalStore(
    subscribeShowSteps,
    getShowSteps,
    readStoredShowSteps,
  );

  // Direction sub-filter — URL param only.
  const rawDir = searchParams.get('dir');
  const dir: ActivityDir = rawDir === 'in' ? 'in' : rawDir === 'out' ? 'out' : 'all';

  // The conversation-direction filter (Inbox/Outbox) and the step axis are
  // mutually exclusive. Two axes: direction triages the conversation layer,
  // while the step axis (Show tool steps AND Failed only) overlays the agent's
  // own work/failures on the full timeline. A failure is a step/processing
  // event, not a directional message, so Failed only lives on the step axis too.
  // Mixing them (e.g. Inbox + steps, or Inbox + Failed only) reads incongruent.
  // So a direction filter neutralizes BOTH step toggles. Deriving here (rather
  // than mutating storage) keeps the user's preferences intact for when they
  // return to All, and deterministically self-heals any legacy combo persisted
  // before this rule existed: a non-All direction plus a step toggle resolves to
  // the conversation view (direction kept, toggles read off) on load, with no
  // transient, no flicker, and no possible "all controls hidden" dead end.
  const showToolSteps = storedShowSteps && dir === 'all';

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

  // Failed-only — URL param only. On the step axis, so a direction filter
  // neutralizes it (mirrors showToolSteps above).
  const failedOnly = searchParams.get('failed') === '1' && dir === 'all';

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
    dir,
    failedOnly,
    showToolSteps,
    setDir,
    setFailedOnly,
    setShowToolSteps: setShowStepsGlobal,
  };
}
