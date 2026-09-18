import { AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { BusyConfirmModal, ProgressOverlay } from '@/components/restart-shared';
import { useRuntimeUpgradeAction } from '@/hooks/useRuntimeUpgradeAction';

/**
 * "Update Anima · old → new" at the foot of the settings list.
 *
 * Exists ONLY while an update is actually available — there is no resting
 * state, no dot, no "up to date" row; absence is the signal. Pressing it runs
 * the same decision the Server page's Version row runs (all agents idle →
 * apply at once; agents mid-item → one continuity confirm naming them) and
 * stays on the current page throughout. The install/restart progress overlay
 * and the reload on recovery come from the shared hook.
 *
 * Two exceptions to "absence is the signal", both scoped to an update THIS
 * button started: while it is installing, and after the worker reports the
 * install failed. The Server page has its own FailedCard for that, but the
 * user may have pressed this button from Providers or Token usage, where
 * nothing else would say so — so the failure is spelled out here, with a
 * retry, until the next attempt. Neither depends on the status still reading
 * "available": a check error mid-install must not swallow the operation.
 */
export default function UpdateAnimaButton() {
  const {
    status,
    phase,
    applyError,
    installFailure,
    runningNames,
    availableTarget,
    inProgressTarget,
    inProgress,
    requestUpgrade,
    performUpgrade,
    cancelConfirm,
  } = useRuntimeUpgradeAction();

  if (!status) return null;
  const offered = status.state === 'available' && !!availableTarget;
  // Feedback for an operation THIS button owns outlives the offer: while the
  // user is confirming, while the apply request is in flight or installing,
  // after the worker failed the install, and after the apply request itself
  // was rejected. Every one of those keeps the footer on screen with a retry.
  const ownOperation = phase !== 'idle' || installFailure !== null || applyError !== null;
  if (!offered && !ownOperation) return null;
  const showButton = offered || phase !== 'idle';

  return (
    <div className="border-t border-border-soft p-2">
      {showButton && (
      <button
        type="button"
        onClick={requestUpgrade}
        disabled={inProgress}
        aria-label={
          inProgress
            ? `Updating Anima to ${inProgressTarget ?? availableTarget}`
            : `Update Anima, ${status.currentVersion} to ${availableTarget}`
        }
        title={inProgress ? undefined : 'Install the update and restart'}
        className={[
          'flex min-h-[44px] w-full items-center gap-2.5 rounded-sm bg-surface px-2.5 py-1.5 text-left font-sans text-[12px] text-text ring-1 ring-border-soft transition-colors',
          inProgress ? 'cursor-wait' : 'hover:bg-surface-raised hover:ring-border-strong',
          'focus-visible:outline-none focus-visible:ring-accent',
        ].join(' ')}
      >
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-white"
        >
          {inProgress ? (
            <RefreshCw className="h-[11px] w-[11px] animate-spin" strokeWidth={2.2} />
          ) : (
            <Download className="h-[11px] w-[11px]" strokeWidth={2.2} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate">{inProgress ? 'Updating Anima…' : 'Update Anima'}</span>
          {!inProgress && availableTarget && (
            <span aria-hidden className="truncate font-mono text-[10px] text-text-subtle">
              {shortVersion(status.currentVersion)} → {shortVersion(availableTarget)}
            </span>
          )}
        </span>
      </button>
      )}
      {installFailure && phase !== 'applying' && (
        <InstallFailedNote
          currentVersion={status.currentVersion}
          error={installFailure.error}
          rollback={installFailure.rollback}
          onRetry={showButton ? undefined : requestUpgrade}
        />
      )}
      {applyError && phase !== 'applying' && (
        <div role="alert" className="mt-1.5 px-1 font-sans text-[11px] leading-snug text-health-error">
          <p>{applyError}</p>
          {!showButton && <RetryButton onRetry={requestUpgrade} />}
        </div>
      )}

      {phase === 'confirming' && (
        <BusyConfirmModal
          kind="upgrade"
          runningNames={runningNames}
          target={availableTarget ?? inProgressTarget ?? ''}
          onCancel={cancelConfirm}
          onConfirm={() => void performUpgrade()}
        />
      )}
      {phase === 'applying' && (
        <ProgressOverlay
          above
          title={`Installing ${inProgressTarget ?? availableTarget}…`}
          body="Your current version keeps running while Anima installs and verifies the new one, then asks any working agents to pause before restart. The dashboard reloads automatically when it's back."
        />
      )}
    </div>
  );
}

/**
 * The install failed before the restart (the dashboard never went down, so the
 * user is still on `currentVersion`). Compact sibling of the Server page's
 * FailedCard, same wording. `onRetry` renders a "Try again" only when the
 * update button itself is not on screen to serve as the retry.
 */
function InstallFailedNote({
  currentVersion,
  error,
  rollback,
  onRetry,
}: {
  currentVersion: string;
  error?: string;
  rollback?: 'not_needed' | 'succeeded' | 'failed';
  onRetry?: () => void;
}) {
  const rollbackFailed = rollback === 'failed';
  return (
    <div
      role="alert"
      className="mt-1.5 rounded-sm border border-health-error/40 bg-health-error/[0.06] px-2 py-1.5 font-sans text-[11px] leading-snug text-text"
    >
      <div className="flex items-start gap-1.5">
        <AlertTriangle aria-hidden className="mt-px h-3 w-3 shrink-0 text-health-error" />
        {rollbackFailed ? (
          <span>Update failed and rollback didn&apos;t complete. The runtime may need attention.</span>
        ) : (
          <span>
            Update failed: still on <span className="font-mono text-[10px]">{currentVersion}</span>
          </span>
        )}
      </div>
      {error && (
        <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-text-muted">{error}</p>
      )}
      {onRetry && <RetryButton onRetry={onRetry} />}
    </div>
  );
}

/** The retry that stands in for the update button while the offer is gone. */
function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="mt-1.5 flex min-h-[44px] items-center gap-1.5 rounded-sm border border-border-soft px-2 py-0.5 text-[11px] md:min-h-[28px] text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <RefreshCw aria-hidden className="h-3 w-3" />
      Try again
    </button>
  );
}

/**
 * Canary versions carry the commit SHA (`0.1.1-canary.75.1.80810fb`); two of
 * them do not fit a 256px column. Drop the trailing SHA segment for the pair
 * shown on the button; the full strings stay on the Server page.
 */
export function shortVersion(version: string): string {
  return version.replace(/\.[0-9a-f]{7,}$/i, '');
}
