import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  applyRuntimeUpgrade,
  fetchRuntimeUpgrade,
  RuntimeUpgradeApplyError,
} from '@/api/system';
import { useAgents } from '@/hooks/useAgentDirectory';
import { useRuntimeUpgrade } from '@/hooks/useRuntimeUpgrade';
import { agentDisplayName } from '@/lib/agent-avatar';
import { queryKeys } from '@/lib/query-keys';
import type { RuntimeUpgradeGateBlocker, RuntimeUpgradeOperation } from '@shared/runtime-upgrade';

// Apply lifecycle: the worker installs the target (dashboard stays up), then
// uses the drain-to-quiescent restart path (dashboard goes down, then recovers).
// A broken target fails BEFORE the restart, so the dashboard never goes down —
// we poll the status endpoint to catch that fast-fail without waiting out the
// whole timeout, and treat a fetch failure as "restart in progress".
const UPGRADE_TIMEOUT_MS = 300_000; // install + restart can take a couple of minutes
const UPGRADE_POLL_MS = 1_500;

export type RuntimeUpgradePhase = 'idle' | 'confirming' | 'applying';

/**
 * The one upgrade state machine, shared by every trigger that can start a
 * system update: the Version row on the Server page and the "Update Anima"
 * button at the foot of the settings list. Both must behave identically —
 * all agents idle → apply at once; agents mid-item → one continuity confirm
 * naming them — so the decision lives here and the triggers only render.
 *
 * Each caller owns its own `phase` (the confirm and the progress overlay are
 * mounted by whichever trigger the user pressed); the server-side operation
 * status is shared through the deduped `useRuntimeUpgrade` query, so a
 * trigger that did NOT start the upgrade still sees it as in progress.
 */
export function useRuntimeUpgradeAction() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useRuntimeUpgrade();
  const { data: agents = [] } = useAgents();
  const [phase, setPhase] = useState<RuntimeUpgradePhase>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);
  // The failed server-side operation the poll below caught for an upgrade THIS
  // trigger started. The Server page's Version row reads the same failure off
  // the shared query, but a trigger on any other page has no such row, so it
  // must carry its own copy until the user retries.
  const [installFailure, setInstallFailure] = useState<RuntimeUpgradeOperation | null>(null);
  // Target captured when the apply was accepted: the status can flip away from
  // "available" mid-install (check error, failure), and the in-progress /
  // failure copy must keep naming what we actually started installing.
  const [startedTarget, setStartedTarget] = useState<string | null>(null);

  const op = status?.operation.status;
  // What a *forward* update would move you to: always the latest on the track.
  // NOT status.operation.targetVersion — that is the last *completed* operation's
  // target, which is historical and can be older than the current version. Reusing
  // it here surfaced a phantom "downgrade" (e.g. 135 → 132) on the available card.
  const availableTarget = status?.latestOnTrack ?? status?.operation.targetVersion;

  async function performUpgrade() {
    setApplyError(null);
    setInstallFailure(null);
    try {
      await applyRuntimeUpgrade();
      setStartedTarget(availableTarget ?? null);
      setPhase('applying');
    } catch (err) {
      setPhase('idle');
      if (err instanceof RuntimeUpgradeApplyError && err.status === 409) {
        setApplyError('An agent started working. Try again once idle.');
      } else if (err instanceof RuntimeUpgradeApplyError && err.status === 503) {
        setApplyError('Update is unavailable right now.');
      } else {
        setApplyError(err instanceof Error ? err.message : 'Upgrade failed to start.');
      }
    }
  }

  // Drive the in-progress UI off the live status endpoint. See the note above
  // for why this polls status rather than only /api/health.
  useEffect(() => {
    if (phase !== 'applying') return;
    let sawDown = false;
    let cancelled = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      if (Date.now() - startedAt > UPGRADE_TIMEOUT_MS) {
        window.location.reload();
        return;
      }
      try {
        const next = await fetchRuntimeUpgrade();
        if (cancelled) return;
        if (sawDown) {
          // Services went down then answered again → restart completed. Reload
          // so the fresh status (succeeded → current, or failed → failed card)
          // becomes the source of truth.
          window.location.reload();
          return;
        }
        if (next.operation.status === 'failed') {
          // Fast-fail before the restart ever happened — surface it now, on
          // the page that started it.
          setInstallFailure(next.operation);
          setPhase('idle');
          void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeUpgrade() });
          return;
        }
        // Still installing / scheduled / running pre-restart — keep waiting.
      } catch {
        sawDown = true;
      }
      timer = setTimeout(tick, UPGRADE_POLL_MS);
    }

    timer = setTimeout(tick, UPGRADE_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, queryClient]);

  // Running agents we'd drain — names the upgrade confirm. Queued items are NOT
  // blockers in drain mode (the new worker picks them up), so filter to running.
  const runningNames = status ? runningBlockerNames(status.gate.blockers, agents) : [];

  // All idle → execute immediately (no modal). Agents working → confirm with
  // continuity copy naming them. Shared by Upgrade, Retry and the footer button.
  function requestUpgrade() {
    if (runningNames.length > 0) {
      setPhase('confirming');
    } else {
      void performUpgrade();
    }
  }

  // What a live server-side operation is installing — authoritative only while that
  // operation is actually running/scheduled. For a client-initiated apply the server
  // op has not yet flipped to running, so fall back to availableTarget; the
  // "Updating to…" label then never echoes the stale completed-op target.
  const serverInProgress = op === 'scheduled' || op === 'running';
  const inProgressTarget = serverInProgress
    ? status?.operation.targetVersion ?? startedTarget ?? availableTarget
    : startedTarget ?? availableTarget;
  const inProgress = phase === 'applying' || serverInProgress;

  return {
    status,
    isLoading,
    phase,
    applyError,
    installFailure,
    runningNames,
    availableTarget,
    inProgressTarget,
    inProgress,
    requestUpgrade,
    performUpgrade,
    cancelConfirm: () => setPhase('idle'),
  };
}

/**
 * Names the agents we'd drain (running only). Queued items are not blockers in
 * drain mode, so they're filtered out — naming a queued agent in the confirm
 * would be wrong (it's never interrupted).
 */
export function runningBlockerNames(
  blockers: RuntimeUpgradeGateBlocker[],
  agents: { id: string; profile?: { displayName?: string } }[],
): string[] {
  const nameById = new Map(agents.map((a) => [a.id, agentDisplayName(a)]));
  return blockers
    .filter((b) => b.status === 'running')
    .map((b) => nameById.get(b.agentId) ?? b.agentId);
}
