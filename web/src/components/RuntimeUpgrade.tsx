import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { fetchAgents } from '@/api/agents';
import {
  applyRuntimeUpgrade,
  checkRuntimeUpgrade,
  fetchRuntimeUpgrade,
  RuntimeUpgradeApplyError,
} from '@/api/system';
import { useRuntimeUpgrade } from '@/hooks/useRuntimeUpgrade';
import { queryKeys } from '@/lib/query-keys';
import { queryClient } from '@/query-client';
import { BusyConfirmModal, restartEcho, resumedText } from './restart-shared';
import type { RuntimeUpgradeGateBlocker, RuntimeUpgradeOperation } from '@shared/runtime-upgrade';

// Apply lifecycle: the worker installs the target (dashboard stays up), then
// uses the drain-to-quiescent restart path (dashboard goes down, then recovers).
// A broken target fails BEFORE the restart, so the dashboard never goes down —
// we poll the status endpoint to catch that fast-fail without waiting out the
// whole timeout, and treat a fetch failure as "restart in progress".
const UPGRADE_TIMEOUT_MS = 300_000; // install + restart can take a couple of minutes
const UPGRADE_POLL_MS = 1_500;
// `operation` never resets to `idle` server-side — it persists succeeded/failed
// until the next apply. Age the failure card out so the panel doesn't get stuck
// on a stale banner; past the window we lean on `state` + version for resting
// (an available update still offers a normal Upgrade, i.e. another retry path).
const RECENT_FAILURE_MS = 60 * 60_000;

type Phase = 'idle' | 'confirming' | 'applying';

/**
 * System-update row in the ServerPanel System section. Renders the honest
 * display state derived from the server discriminant — the UI never infers
 * available-vs-current, and never shows the release track:
 *
 *   checking  (client query in-flight, no data yet)  → spinner row
 *   error     (status.state)                          → "Update check unavailable"
 *   current   (status.state)                          → "Up to date" (+ resume echo)
 *   available (status.state)                          → card + Upgrade
 *   upgrading (operation.status running/scheduled)    → spinner row + overlay
 *   failed    (operation.status)                      → "still on <old>" + Retry
 *
 * Drain mode: agents working no longer DISABLES the upgrade — it routes through
 * a continuity-first confirm naming the running agents. The only disabler left
 * is a mid-operation (scheduled/running) upgrade, which shows the spinner.
 */
export default function RuntimeUpgradeRow() {
  const { data: status, isLoading } = useRuntimeUpgrade();
  const { data: agents = [] } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const [phase, setPhase] = useState<Phase>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);
  const checkMutation = useMutation({
    mutationFn: checkRuntimeUpgrade,
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.runtimeUpgrade(), next);
    },
  });

  async function performUpgrade() {
    setApplyError(null);
    try {
      await applyRuntimeUpgrade();
      setPhase('applying');
    } catch (err) {
      setPhase('idle');
      if (err instanceof RuntimeUpgradeApplyError && err.status === 409) {
        setApplyError('An agent started working — try again once idle.');
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
          // Fast-fail before the restart ever happened — surface it now.
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
  }, [phase]);

  // checking — client loading, nothing cached yet
  if (isLoading && !status) {
    return (
      <UpdateLabelRow>
        <RefreshCw aria-hidden className="h-3 w-3 animate-spin text-text-subtle" />
        <span className="font-serif text-[14px] text-text-muted">Checking for updates…</span>
      </UpdateLabelRow>
    );
  }
  // No data and not loading (transient fetch error with empty cache) — stay
  // silent rather than render a scary error in the System section.
  if (!status) return null;

  const op = status.operation.status;
  const target = status.operation.targetVersion ?? status.latestOnTrack;
  const inProgress = phase === 'applying' || op === 'scheduled' || op === 'running';
  const completedAt = status.operation.completedAt;
  const failureFresh = op === 'failed' && isFailureFresh(completedAt);
  const checkFailed = checkMutation.isError;
  const checkAction = !inProgress ? (
    <CheckNowButton
      checking={checkMutation.isPending}
      onCheck={() => checkMutation.mutate()}
    />
  ) : undefined;

  // Running agents we'd drain — names the upgrade confirm. Queued items are NOT
  // blockers in drain mode (the new worker picks them up), so filter to running.
  const runningNames = runningBlockerNames(status.gate.blockers, agents);

  // Honest resume echo for the upgrade path: "N agents resumed" rides the
  // version-flip surface (the "Up to date" row), gated on the same drain-vs-
  // fallback + resumedCount + freshness rule as the restart toast.
  const upgradeEcho = restartEcho(echoSignal(status.operation));
  const upgradeResumed = upgradeEcho?.kind === 'resumed' ? upgradeEcho.count : null;

  // All idle → execute immediately (no modal). Agents working → confirm with
  // continuity copy naming them. Shared by the Upgrade button and Retry.
  function requestUpgrade() {
    if (runningNames.length > 0) {
      setPhase('confirming');
    } else {
      void performUpgrade();
    }
  }

  let content: React.ReactNode;
  if (inProgress) {
    content = (
      <UpdateLabelRow>
        <RefreshCw aria-hidden className="h-3 w-3 animate-spin text-accent" />
        <span className="font-serif text-[14px] text-text">
          {target ? `Updating to ${target}…` : 'Updating…'}
        </span>
      </UpdateLabelRow>
    );
  } else if (failureFresh) {
    content = (
      <FailedCard
        currentVersion={status.currentVersion}
        error={status.operation.error}
        rollback={status.operation.rollback}
        logPath={status.operation.logPath}
        onRetry={requestUpgrade}
      />
    );
  } else if (status.state === 'error') {
    content = (
      <UpdateLabelRow action={checkAction}>
        <span
          className="font-serif text-[14px] text-text-muted"
          title={status.checkError?.message}
        >
          Update check unavailable
        </span>
        {checkFailed && <CheckFailedLabel />}
      </UpdateLabelRow>
    );
  } else if (status.state === 'available' && target) {
    content = (
      <AvailableCard
        currentVersion={status.currentVersion}
        target={target}
        error={applyError}
        onUpgrade={requestUpgrade}
        action={checkAction}
        checkFailed={checkFailed}
      />
    );
  } else {
    // current (up to date) — with the post-upgrade resume echo when fresh.
    content = (
      <UpdateLabelRow action={checkAction}>
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-health-ok" />
        <span className="font-serif text-[14px] text-text">Up to date</span>
        {upgradeResumed !== null && (
          <span className="font-sans text-[11px] text-text-subtle">
            · {resumedText(upgradeResumed)}
          </span>
        )}
        {checkFailed && <CheckFailedLabel />}
      </UpdateLabelRow>
    );
  }

  return (
    <>
      {content}
      {phase === 'confirming' && target && (
        <BusyConfirmModal
          kind="upgrade"
          runningNames={runningNames}
          target={target}
          onCancel={() => setPhase('idle')}
          onConfirm={() => void performUpgrade()}
        />
      )}
      {phase === 'applying' && <UpgradeOverlay target={target} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Cards & rows
// ---------------------------------------------------------------------------

function AvailableCard({
  currentVersion,
  target,
  error,
  onUpgrade,
  action,
  checkFailed,
}: {
  currentVersion: string;
  target: string;
  error: string | null;
  onUpgrade: () => void;
  action?: React.ReactNode;
  checkFailed?: boolean;
}) {
  const long = isLongPair(currentVersion, target);
  return (
    <div className="rounded-sm border border-accent/30 bg-accent/[0.06] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <span className="font-serif text-[14px] font-medium text-text">
            Update available
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!long && <VersionPair from={currentVersion} to={target} />}
          {action}
        </div>
      </div>

      {long && (
        <div className="mt-1.5">
          <VersionPair from={currentVersion} to={target} stacked />
        </div>
      )}

      <div className="mt-2.5">
        <button
          type="button"
          onClick={onUpgrade}
          className="flex w-full items-center justify-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-page"
        >
          <Download aria-hidden className="h-3 w-3" />
          Upgrade &amp; restart
        </button>
        {error && <p className="mt-1.5 font-sans text-[11px] text-health-error">{error}</p>}
        {checkFailed && (
          <p className="mt-1.5 font-sans text-[11px] text-text-subtle">
            Check failed — showing last known.
          </p>
        )}
      </div>
    </div>
  );
}

function FailedCard({
  currentVersion,
  error,
  rollback,
  logPath,
  onRetry,
}: {
  currentVersion: string;
  error?: string;
  rollback?: 'not_needed' | 'succeeded' | 'failed';
  logPath?: string;
  onRetry: () => void;
}) {
  // The reassuring path (install failed cleanly OR rolled back): the dashboard
  // is answering and reports it's on `currentVersion`, so nothing's bricked.
  // The one genuinely alarming case is a *failed* rollback — we must not claim
  // "still on <old>" then, since the running version is no longer guaranteed.
  const rollbackFailed = rollback === 'failed';
  return (
    <div className="rounded-sm border border-health-error/40 bg-health-error/[0.06] p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-health-error" />
        {rollbackFailed ? (
          <span className="font-serif text-[14px] font-medium text-text">
            Update failed and rollback didn&apos;t complete — the runtime may need attention.
          </span>
        ) : (
          <span className="font-serif text-[14px] font-medium text-text">
            Update failed — still on{' '}
            <span className="font-mono text-[12px] text-text-muted">{currentVersion}</span>
            <span className="font-sans text-[12px] font-normal text-text-subtle">
              {' '}· nothing else changed
            </span>
          </span>
        )}
      </div>
      {error && (
        <p className="mt-1.5 break-words font-mono text-[10px] leading-relaxed text-text-subtle">
          {error}
        </p>
      )}
      {logPath && (
        <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-text-subtle opacity-70">
          log: {logPath}
        </p>
      )}
      <div className="mt-2.5">
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded-sm border border-border-soft px-2.5 py-1 text-[12px] text-text-muted transition-colors hover:border-border-soft hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <RefreshCw aria-hidden className="h-3 w-3" />
          Try again
        </button>
      </div>
    </div>
  );
}

/**
 * Version pair. Inline `current → target` for short release versions (the
 * approved look); stacked + break-all once either side is a long prerelease
 * (e.g. 0.1.1-canary.5.1.723b529) so two of them never overflow the card,
 * worst at 375px.
 */
function VersionPair({ from, to, stacked = false }: { from: string; to: string; stacked?: boolean }) {
  if (stacked) {
    return (
      <div className="font-mono text-[11px] leading-snug">
        <div className="break-all text-text-subtle">{from}</div>
        <div className="break-all text-text">
          <span className="text-text-subtle">→</span> {to}
        </div>
      </div>
    );
  }
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-text-muted">
      {from} <span className="text-text-subtle">→</span> {to}
    </span>
  );
}

function UpdateLabelRow({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="group/update-row flex items-center gap-3">
      <span className="w-14 shrink-0 font-sans text-[11px] text-text-subtle">Update</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">{children}</div>
      {action}
    </div>
  );
}

function CheckNowButton({
  checking,
  onCheck,
}: {
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCheck}
      disabled={checking}
      aria-label={checking ? 'Checking for updates' : 'Check for updates'}
      title={checking ? 'Checking for updates…' : 'Check for updates'}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-subtle opacity-40 transition hover:bg-surface-elevated hover:text-text hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-default disabled:opacity-70 group-hover/update-row:opacity-100"
    >
      <RefreshCw aria-hidden className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />
    </button>
  );
}

function CheckFailedLabel() {
  return (
    <span className="font-sans text-[11px] text-text-subtle">
      Check failed — showing last known.
    </span>
  );
}

// ---------------------------------------------------------------------------
// Overlay (editorial style, mirrors RestartButton)
// ---------------------------------------------------------------------------

function UpgradeOverlay({ target }: { target?: string }) {
  // Portal to body — same drawer-trapping reason as BusyConfirmModal: this row
  // lives inside the ServerPanel, whose positioned/scroll container would
  // otherwise confine `fixed inset-0` to the ~330px drawer.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-page/70 p-4 backdrop-blur-sm">
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-sm border border-border-soft bg-surface px-10 py-7 text-center shadow-deep">
        <RefreshCw className="h-6 w-6 animate-spin text-accent" />
        <div className="font-serif text-[16px] font-medium text-text">
          {target ? `Installing ${target}…` : 'Installing update…'}
        </div>
        {/* Continuity-first default. The old idle-wait line ("waits for a working
            agent to finish") survives here, reframed as "at a safe point" — which
            is honest for BOTH the drain path (clean edge reached quickly) and the
            drain-timeout fallback (waits for a safe point; v1 never force-kills). */}
        <div className="font-sans text-[12px] leading-relaxed text-text-muted">
          Your current version keeps running while Anima installs and verifies the new one, then
          restarts at a safe point so any working agents resume right where they left off. The
          dashboard reloads automatically when it&apos;s back.
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stacked layout kicks in once a version pair won't sit comfortably on one row. */
function isLongPair(a: string, b: string): boolean {
  return a.length > 12 || b.length > 12 || a.length + b.length > 22;
}

/**
 * Names the agents we'd drain (running only). Queued items are not blockers in
 * drain mode, so they're filtered out — naming a queued agent in the confirm
 * would be wrong (it's never interrupted).
 */
function runningBlockerNames(
  blockers: RuntimeUpgradeGateBlocker[],
  agents: { id: string; profile?: { displayName?: string } }[],
): string[] {
  const nameById = new Map(agents.map((a) => [a.id, a.profile?.displayName ?? a.id]));
  return blockers
    .filter((b) => b.status === 'running')
    .map((b) => nameById.get(b.agentId) ?? b.agentId);
}

/** Map the upgrade operation's restart result into the shared echo signal. */
function echoSignal(op: RuntimeUpgradeOperation) {
  return {
    completedAt: op.completedAt,
    fallbackToIdle: op.restart?.fallbackToIdle,
    mode: op.restart?.mode,
    resumedCount: op.restart?.resumedCount,
  };
}

function isFailureFresh(completedAt: string | undefined): boolean {
  return !completedAt || Date.now() - Date.parse(completedAt) < RECENT_FAILURE_MS;
}
