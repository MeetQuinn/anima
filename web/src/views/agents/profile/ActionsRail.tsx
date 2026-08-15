/**
 * ActionsRail — task #185 (totoday): the AgentActionsMenu lifecycle actions
 * surfaced as large, always-visible buttons in the Profile tab's right column
 * (desktop only; mobile and the header keep the ⋯ menu — totoday: 留着吧).
 *
 * Style: letterpress plates — the neo-brutalist reference (hard offset
 * shadow, chunky border) translated into house ink + paper. Hover nudges the
 * plate toward its shadow; press seats it flush (shadow gone). Disabled
 * plates lie flat: no shadow, faded ink. Approved by totoday 08-15.
 *
 * Logic lives in `useAgentActions` (shared with the ⋯ menu): a running agent
 * blocks Disable, a disabled agent blocks Restart, confirms and refresh side
 * effects are identical. `ActionsRail` itself is presentational;
 * `ProfileActionsRail` is the connected surface the Profile page mounts.
 */
import { ClipboardCheck, ClipboardCopy, Power, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { useAgentActions } from '@/hooks/useAgentActions';

type RailAction = {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
};

/* Letterpress plate buttons. */
const baseButton =
  'flex min-h-[48px] w-full items-center gap-3 border-[1.5px] px-4 text-left font-serif text-[15px] font-medium transition-all duration-100 disabled:cursor-not-allowed disabled:translate-x-0 disabled:translate-y-0 disabled:opacity-40 disabled:shadow-none';
const quietButton =
  'border-text bg-surface-raised text-text shadow-[3px_3px_0_0_var(--color-text)] hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-[2px_2px_0_0_var(--color-text)] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none';
const dangerButton =
  'border-health-error bg-health-error-soft/70 text-health-error shadow-[3px_3px_0_0_var(--color-health-error)] hover:translate-x-[1px] hover:translate-y-[1px] hover:bg-health-error-soft hover:shadow-[2px_2px_0_0_var(--color-health-error)] active:translate-x-[3px] active:translate-y-[3px] active:shadow-none';

function RailButton({ action }: { action: RailAction }) {
  return (
    <button
      type="button"
      disabled={action.disabled}
      title={action.disabled ? action.disabledReason : undefined}
      onClick={action.onSelect}
      className={`${baseButton} ${action.danger ? dangerButton : quietButton}`}
    >
      <span className={`shrink-0 ${action.danger ? 'text-health-error' : 'text-text'}`} aria-hidden>
        {action.icon}
      </span>
      {action.label}
    </button>
  );
}

export function ActionsRail({
  enabled,
  running,
  toggling,
  copyingDiagnostics,
  diagnosticsCopied,
  showRestart,
  onToggleEnabled,
  onRotateSession,
  onRestart,
  onCopyDiagnostics,
  onRemove,
}: {
  enabled: boolean;
  running: boolean;
  toggling: boolean;
  copyingDiagnostics: boolean;
  diagnosticsCopied: boolean;
  showRestart: boolean;
  onToggleEnabled: (nextEnabled: boolean) => void;
  onRotateSession: () => void;
  onRestart: () => void;
  onCopyDiagnostics: () => void;
  onRemove: () => void;
}) {
  const iconClass = 'h-4 w-4';
  const actions: RailAction[] = [
    {
      key: 'toggle',
      label: toggling ? 'Saving…' : enabled ? 'Disable' : 'Enable',
      icon: <Power className={iconClass} />,
      disabled: toggling || (enabled && running),
      disabledReason: enabled && running ? 'Agent is running. Stop the agent before disabling.' : undefined,
      onSelect: () => onToggleEnabled(!enabled),
    },
    {
      key: 'rotate',
      label: 'Rotate session',
      icon: <RotateCcw className={iconClass} />,
      onSelect: onRotateSession,
    },
    // Restart is suppressed (not greyed) when provider health says restart is
    // not the remedy — mirroring the ⋯ menu. The menu swaps in a "go to
    // provider settings" row there; the rail lives ON the profile page, where
    // that remedy UI already sits above it, so it shows nothing instead.
    ...(showRestart
      ? [
          {
            key: 'restart',
            label: 'Restart agent',
            icon: <RefreshCw className={iconClass} />,
            disabled: !enabled,
            disabledReason: 'Agent is disabled. Enable it to run.',
            onSelect: onRestart,
          } satisfies RailAction,
        ]
      : []),
    {
      key: 'diagnostics',
      label: diagnosticsCopied ? 'Copied' : 'Copy diagnostics',
      icon: diagnosticsCopied ? (
        <ClipboardCheck className={`${iconClass} text-health-ok`} />
      ) : (
        <ClipboardCopy className={iconClass} />
      ),
      disabled: copyingDiagnostics,
      onSelect: onCopyDiagnostics,
    },
  ];

  return (
    <aside aria-label="Agent actions" className="w-60 shrink-0">
      <div className="flex items-center gap-3">
        <span className="chrome text-[10px] tracking-[0.14em] text-text-subtle">Actions</span>
        <span aria-hidden className="h-px flex-1 bg-border-strong" />
      </div>
      <div className="mt-4 flex flex-col gap-3">
        {actions.map((action) => (
          <RailButton key={action.key} action={action} />
        ))}
      </div>
      <div className="mt-7 flex flex-col gap-3">
        <RailButton
          action={{
            key: 'remove',
            label: 'Remove agent',
            icon: <Trash2 className={iconClass} />,
            danger: true,
            onSelect: onRemove,
          }}
        />
      </div>
    </aside>
  );
}

/** The connected rail the Profile page mounts (desktop only at the call site). */
export function ProfileActionsRail() {
  const {
    agent,
    enabled,
    running,
    toggling,
    copyingDiagnostics,
    diagnosticsCopied,
    providerAction,
    restartBlocked,
    toggleEnabled,
    copyDiagnostics,
    confirmRotateSession,
    confirmRestart,
    confirmRemove,
    modal,
  } = useAgentActions();

  if (!agent) return null;

  return (
    <>
      <ActionsRail
        enabled={enabled}
        running={running}
        toggling={toggling}
        copyingDiagnostics={copyingDiagnostics}
        diagnosticsCopied={diagnosticsCopied}
        showRestart={!providerAction && !restartBlocked}
        onToggleEnabled={(next) => void toggleEnabled(next)}
        onRotateSession={confirmRotateSession}
        onRestart={confirmRestart}
        onCopyDiagnostics={() => void copyDiagnostics()}
        onRemove={confirmRemove}
      />
      {modal}
    </>
  );
}
