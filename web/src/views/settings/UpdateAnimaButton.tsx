import { Download, RefreshCw } from 'lucide-react';
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
 */
export default function UpdateAnimaButton() {
  const {
    status,
    phase,
    applyError,
    runningNames,
    availableTarget,
    inProgressTarget,
    inProgress,
    requestUpgrade,
    performUpgrade,
    cancelConfirm,
  } = useRuntimeUpgradeAction();

  if (!status || status.state !== 'available' || !availableTarget) return null;

  return (
    <div className="border-t border-border-soft p-2">
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
          {!inProgress && (
            <span aria-hidden className="truncate font-mono text-[10px] text-text-subtle">
              {shortVersion(status.currentVersion)} → {shortVersion(availableTarget)}
            </span>
          )}
        </span>
      </button>
      {applyError && (
        <p role="alert" className="mt-1.5 px-1 font-sans text-[11px] text-health-error">
          {applyError}
        </p>
      )}

      {phase === 'confirming' && (
        <BusyConfirmModal
          kind="upgrade"
          runningNames={runningNames}
          target={availableTarget}
          onCancel={cancelConfirm}
          onConfirm={() => void performUpgrade()}
        />
      )}
      {phase === 'applying' && (
        <ProgressOverlay
          above
          title={`Installing ${availableTarget}…`}
          body="Your current version keeps running while Anima installs and verifies the new one, then asks any working agents to pause before restart. The dashboard reloads automatically when it's back."
        />
      )}
    </div>
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
