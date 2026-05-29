import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { fetchAgents } from '@/api/agents';
import { applyRuntimeUpgrade, fetchRuntimeUpgrade, RuntimeUpgradeApplyError } from '@/api/system';
import { useRuntimeUpgrade } from '@/hooks/useRuntimeUpgrade';
import { queryKeys } from '@/lib/query-keys';
import { queryClient } from '@/query-client';
import type { RuntimeUpgradeGateBlocker } from '@shared/runtime-upgrade';

// Apply lifecycle: the worker installs the target (dashboard stays up), then
// uses the idle-gated restart path (dashboard goes down, then recovers). A
// broken target fails BEFORE the restart, so the dashboard never goes down —
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
 *   current   (status.state)                          → "Up to date"
 *   available (status.state)                          → card + Upgrade (gate-gated)
 *   upgrading (operation.status running/scheduled)    → spinner row + overlay
 *   failed    (operation.status)                      → "still on <old>" + Retry
 */
export default function RuntimeUpgradeRow() {
  const { data: status, isLoading } = useRuntimeUpgrade();
  const { data: agents = [] } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const [phase, setPhase] = useState<Phase>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);

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
        <RefreshCw aria-hidden className="h-3 w-3 animate-spin text-text-on-spine-subtle" />
        <span className="font-serif text-[14px] text-text-on-spine-muted">Checking for updates…</span>
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
  const failureFresh =
    op === 'failed' && (!completedAt || Date.now() - Date.parse(completedAt) < RECENT_FAILURE_MS);

  let content: React.ReactNode;
  if (inProgress) {
    content = (
      <UpdateLabelRow>
        <RefreshCw aria-hidden className="h-3 w-3 animate-spin text-accent" />
        <span className="font-serif text-[14px] text-text-on-spine">
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
        gateBusy={status.gate.state === 'busy'}
        gateLabel={gatedLabel(status.gate.blockers, agents)}
        onRetry={() => setPhase('confirming')}
      />
    );
  } else if (status.state === 'error') {
    content = (
      <UpdateLabelRow>
        <span
          className="font-serif text-[14px] text-text-on-spine-muted"
          title={status.checkError?.message}
        >
          Update check unavailable
        </span>
      </UpdateLabelRow>
    );
  } else if (status.state === 'available' && target) {
    content = (
      <AvailableCard
        currentVersion={status.currentVersion}
        target={target}
        gateBusy={status.gate.state === 'busy'}
        gateLabel={gatedLabel(status.gate.blockers, agents)}
        error={applyError}
        onUpgrade={() => setPhase('confirming')}
      />
    );
  } else {
    // current (up to date)
    content = (
      <UpdateLabelRow>
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-health-ok" />
        <span className="font-serif text-[14px] text-text-on-spine">Up to date</span>
      </UpdateLabelRow>
    );
  }

  return (
    <>
      {content}
      {phase === 'confirming' && target && (
        <UpgradeConfirmModal
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
  gateBusy,
  gateLabel,
  error,
  onUpgrade,
}: {
  currentVersion: string;
  target: string;
  gateBusy: boolean;
  gateLabel: string;
  error: string | null;
  onUpgrade: () => void;
}) {
  const long = isLongPair(currentVersion, target);
  return (
    <div className="rounded-sm border border-accent/30 bg-accent/[0.06] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <span className="font-serif text-[14px] font-medium text-text-on-spine">
            Update available
          </span>
        </div>
        {!long && <VersionPair from={currentVersion} to={target} />}
      </div>

      {long && (
        <div className="mt-1.5">
          <VersionPair from={currentVersion} to={target} stacked />
        </div>
      )}

      <div className="mt-2.5">
        {gateBusy ? (
          <>
            <button
              type="button"
              disabled
              className="flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-sm border border-spine-border px-3 py-1.5 text-[12px] text-text-on-spine-subtle opacity-60"
            >
              <Download aria-hidden className="h-3 w-3" />
              Upgrade &amp; restart
            </button>
            <p className="mt-1.5 font-sans text-[11px] text-text-on-spine-subtle">{gateLabel}</p>
          </>
        ) : (
          <button
            type="button"
            onClick={onUpgrade}
            className="flex w-full items-center justify-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-page"
          >
            <Download aria-hidden className="h-3 w-3" />
            Upgrade &amp; restart
          </button>
        )}
        {error && <p className="mt-1.5 font-sans text-[11px] text-health-error">{error}</p>}
      </div>
    </div>
  );
}

function FailedCard({
  currentVersion,
  error,
  rollback,
  logPath,
  gateBusy,
  gateLabel,
  onRetry,
}: {
  currentVersion: string;
  error?: string;
  rollback?: 'not_needed' | 'succeeded' | 'failed';
  logPath?: string;
  gateBusy: boolean;
  gateLabel: string;
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
          <span className="font-serif text-[14px] font-medium text-text-on-spine">
            Update failed and rollback didn&apos;t complete — the runtime may need attention.
          </span>
        ) : (
          <span className="font-serif text-[14px] font-medium text-text-on-spine">
            Update failed — still on{' '}
            <span className="font-mono text-[12px] text-text-on-spine-muted">{currentVersion}</span>
            <span className="font-sans text-[12px] font-normal text-text-on-spine-subtle">
              {' '}· nothing else changed
            </span>
          </span>
        )}
      </div>
      {error && (
        <p className="mt-1.5 break-words font-mono text-[10px] leading-relaxed text-text-on-spine-subtle">
          {error}
        </p>
      )}
      {logPath && (
        <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-text-on-spine-subtle opacity-70">
          log: {logPath}
        </p>
      )}
      <div className="mt-2.5">
        {gateBusy ? (
          <p className="font-sans text-[11px] text-text-on-spine-subtle">{gateLabel}</p>
        ) : (
          <button
            type="button"
            onClick={onRetry}
            className="flex items-center gap-1.5 rounded-sm border border-spine-border px-2.5 py-1 text-[12px] text-text-on-spine-muted transition-colors hover:border-spine-border hover:text-text-on-spine focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <RefreshCw aria-hidden className="h-3 w-3" />
            Try again
          </button>
        )}
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
        <div className="break-all text-text-on-spine-subtle">{from}</div>
        <div className="break-all text-text-on-spine">
          <span className="text-text-on-spine-subtle">→</span> {to}
        </div>
      </div>
    );
  }
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-[12px] text-text-on-spine-muted">
      {from} <span className="text-text-on-spine-subtle">→</span> {to}
    </span>
  );
}

function UpdateLabelRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 font-sans text-[11px] text-text-on-spine-subtle">Update</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm + overlay (editorial style, mirrors RestartButton)
// ---------------------------------------------------------------------------

function UpgradeConfirmModal({
  target,
  onCancel,
  onConfirm,
}: {
  target: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-page/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="upgrade-confirm-title"
        className="relative w-full max-w-xl rounded-sm border border-accent/40 bg-surface p-7 pl-8 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <span aria-hidden className="absolute left-0 top-4 bottom-4 w-px bg-accent" />
        <div id="upgrade-confirm-title" className="font-serif text-[17px] font-semibold text-text">
          Update and restart?
        </div>
        <div className="font-serif mt-2 text-[15px] leading-relaxed text-text-muted">
          Anima will install{' '}
          <span className="font-mono text-[13px] text-text">{target}</span> and restart its
          services. Provider sessions and reminder schedules persist; the dashboard reconnects
          automatically.
        </div>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onConfirm}
            className="flex items-center gap-1.5 rounded-sm bg-accent px-3.5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <Download aria-hidden className="h-3.5 w-3.5" />
            Upgrade &amp; restart
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
    </div>
  );
}

function UpgradeOverlay({ target }: { target?: string }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-page/70 p-4 backdrop-blur-sm">
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-sm border border-border-soft bg-surface px-10 py-7 text-center shadow-deep">
        <RefreshCw className="h-6 w-6 animate-spin text-accent" />
        <div className="font-serif text-[16px] font-medium text-text">
          {target ? `Installing ${target}…` : 'Installing update…'}
        </div>
        <div className="font-sans text-[12px] leading-relaxed text-text-muted">
          Your current version keeps running while Anima installs and verifies the new one. It then
          restarts once no agent is mid-task — so this may wait for a working agent to finish. The
          dashboard reloads automatically when it&apos;s back.
        </div>
      </div>
    </div>
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
 * Gated copy from the server's blockers — name the single common case, count
 * the rest, so the helper line stays short. (The full named roster belongs in
 * the confirm step; v1's apply path is only reachable when the gate is idle.)
 */
function gatedLabel(
  blockers: RuntimeUpgradeGateBlocker[],
  agents: { id: string; profile?: { displayName?: string } }[],
): string {
  if (blockers.length === 0) return 'Available once agents are idle.';
  if (blockers.length === 1) {
    const nameById = new Map(agents.map((a) => [a.id, a.profile?.displayName ?? a.id]));
    const name = nameById.get(blockers[0].agentId) ?? blockers[0].agentId;
    return `${name} is working — available once idle.`;
  }
  return `${blockers.length} agents are working — available once idle.`;
}
