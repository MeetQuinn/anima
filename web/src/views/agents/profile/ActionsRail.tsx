/**
 * ActionsRail — task #185 (totoday): the AgentActionsMenu lifecycle actions
 * surfaced as large, always-visible buttons in the Profile tab's right column
 * (desktop only; mobile and the header keep the ⋯ menu — totoday: 留着吧).
 *
 * Style: quiet ledger cards (totoday 08-17: the letterpress plates read too
 * heavy next to the Setup ledger, and the "Actions" rubric was noise — 直接
 * button 就好). One soft-bordered card of rows sharing the page's rule-and-
 * paper language; Remove sits in its own card below so destruction never
 * neighbors routine. Hover raises the paper a shade; disabled rows fade.
 *
 * Logic lives in `useAgentActions` (shared with the ⋯ menu): Disable while
 * running opens a notice instead of acting, a disabled agent blocks Restart,
 * confirms and refresh side effects are identical. `ActionsRail` itself is presentational;
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

/* Quiet ledger rows: the card carries the border, rows carry only ink. */
const baseButton =
  'flex h-11 w-full items-center gap-2.5 px-3.5 text-left font-serif text-[14px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';
const quietButton = 'text-text hover:bg-surface-elevated';
const dangerButton = 'text-health-error hover:bg-health-error-soft/60';

function RailButton({ action }: { action: RailAction }) {
  return (
    <button
      type="button"
      disabled={action.disabled}
      title={action.disabled ? action.disabledReason : undefined}
      onClick={action.onSelect}
      className={`${baseButton} ${action.danger ? dangerButton : quietButton}`}
    >
      <span
        className={`shrink-0 ${action.danger ? 'text-health-error' : 'text-text-muted'}`}
        aria-hidden
      >
        {action.icon}
      </span>
      {action.label}
    </button>
  );
}

export function ActionsRail({
  enabled,
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
  // Order (totoday 08-17): routine first, by frequency — Restart, Rotate,
  // Copy diagnostics — then Disable last, next to the Remove card below:
  // the two lifecycle-ending actions sit together at the bottom.
  const actions: RailAction[] = [
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
      key: 'rotate',
      label: 'Rotate session',
      icon: <RotateCcw className={iconClass} />,
      onSelect: onRotateSession,
    },
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
    {
      // Always clickable (totoday 08-17): while the agent runs, selecting
      // Disable opens a notice dialog instead of disabling — the explanation
      // lives in useAgentActions.requestDisable, not in a greyed-out row.
      key: 'toggle',
      label: toggling ? 'Saving…' : enabled ? 'Disable' : 'Enable',
      icon: <Power className={iconClass} />,
      disabled: toggling,
      onSelect: () => onToggleEnabled(!enabled),
    },
  ];

  return (
    <aside aria-label="Agent actions" className="w-60 shrink-0">
      {/* No rubric (totoday 08-17): the buttons name themselves. */}
      <div className="divide-y divide-border-soft overflow-hidden rounded-sm border border-border-soft bg-surface">
        {actions.map((action) => (
          <RailButton key={action.key} action={action} />
        ))}
      </div>
      {/* Destruction keeps its own card: a rule is not enough distance. */}
      <div className="mt-3 overflow-hidden rounded-sm border border-health-error/25 bg-surface">
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
    toggling,
    copyingDiagnostics,
    diagnosticsCopied,
    providerAction,
    restartBlocked,
    toggleEnabled,
    requestDisable,
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
        toggling={toggling}
        copyingDiagnostics={copyingDiagnostics}
        diagnosticsCopied={diagnosticsCopied}
        showRestart={!providerAction && !restartBlocked}
        onToggleEnabled={(next) => (next ? void toggleEnabled(true) : requestDisable())}
        onRotateSession={confirmRotateSession}
        onRestart={confirmRestart}
        onCopyDiagnostics={() => void copyDiagnostics()}
        onRemove={confirmRemove}
      />
      {modal}
    </>
  );
}
