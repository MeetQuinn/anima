import { useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router-dom';

// Shared hook for the Activity-view filter state.
//
// The Activity tab is one Slack-style timeline (the conversation) plus a single
// "Show tool steps" toggle (iris-locked spec `795d974`). There is no lens and no
// direction sub-filter: the conversation is always primary and always shows both
// inbound and outbound rows; the toggle interleaves curated tool steps /
// memory-coherence / processing signals as subordinate rows.
//
// Show tool steps:
//   - Persisted in localStorage. Default = false (clean conversation).
//   - OFF = conversation only (messages / files / reactions).
//   - ON  = curated steps (isNarrativeStep) interleaved chronologically.
//   - Migrated from the retired 'anima-activity-show-all-steps' pref: a user who
//     had the old firehose on wanted steps visible, so it maps to ON.
//
// Failed-only filter:
//   - URL param `failed=1`. Implies steps are shown (failure rows are steps).

const SHOW_STEPS_STORAGE_KEY = 'anima-activity-show-tool-steps';
const LEGACY_SHOW_ALL_STORAGE_KEY = 'anima-activity-show-all-steps';

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
  failedOnly: boolean;
  showToolSteps: boolean;
  setFailedOnly: (v: boolean) => void;
  setShowToolSteps: (v: boolean) => void;
}

export function useActivityFilters(): ActivityFilters {
  const [searchParams, setSearchParams] = useSearchParams();

  const showToolSteps = useSyncExternalStore(
    subscribeShowSteps,
    getShowSteps,
    readStoredShowSteps,
  );

  // Failed-only: URL param only. Lives on the step axis (a failure is a step /
  // processing event), so it shows failure rows regardless of the Show tool
  // steps toggle.
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
    failedOnly,
    showToolSteps,
    setFailedOnly,
    setShowToolSteps: setShowStepsGlobal,
  };
}
