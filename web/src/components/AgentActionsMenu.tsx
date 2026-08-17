/**
 * ⋯ overflow menu for per-agent lifecycle actions — Disable/Enable, Rotate
 * session, Remove agent. Used in both AgentHeader (desktop) and MobileTopBar.
 *
 * Action logic (gating, confirms, side effects) lives in `useAgentActions`,
 * shared with the desktop Profile ActionsRail (task #185) so the two surfaces
 * cannot drift. This file owns only the dropdown chrome.
 *
 * Renders the trigger button inline; confirm overlay modals use `fixed` so
 * they appear above everything regardless of containing context.
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Clipboard,
  ClipboardCheck,
  MoreHorizontal,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Button } from './ui/button';
import { useAgentActions } from '@/hooks/useAgentActions';

// ── AgentActionsMenu ──────────────────────────────────────────────────────────

/**
 * The ⋯ overflow menu for lifecycle actions. Renders a button + dropdown +
 * confirm overlay modals. Drop it anywhere in the header — the modals float
 * via fixed positioning.
 *
 * `buttonClassName` lets callers tweak sizing for desktop vs mobile contexts.
 */
export default function AgentActionsMenu({ buttonClassName }: { buttonClassName?: string }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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
    goToProviderSettings,
    modal,
  } = useAgentActions();

  // Click-outside to close the dropdown.
  useEffect(() => {
    if (!menuOpen) return;
    function handle(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [menuOpen]);

  if (!agent) return null;

  return (
    <>
      <div className="relative" ref={menuRef}>
        <Button
          size="xs"
          variant="ghost"
          aria-label="More actions"
          onClick={() => setMenuOpen((v) => !v)}
          className={buttonClassName ?? 'min-h-[44px] min-w-[44px]'}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-10 mt-1 min-w-[180px] rounded-sm border border-border-soft bg-surface py-1 shadow-deep">
            {/* Disable / Enable — top, state-labeled, frequent + reversible.
                Always clickable while running (totoday 08-17): the click opens
                a notice dialog via requestDisable instead of a dead row. */}
            {enabled ? (
              <button
                disabled={toggling}
                className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text disabled:opacity-50"
                onClick={() => {
                  setMenuOpen(false);
                  requestDisable();
                }}
              >
                <PowerOff className="h-3.5 w-3.5 shrink-0" />
                {toggling ? 'Saving...' : 'Disable'}
              </button>
            ) : (
              <button
                disabled={toggling}
                className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text disabled:opacity-50"
                onClick={() => {
                  setMenuOpen(false);
                  void toggleEnabled(true);
                }}
              >
                <Power className="h-3.5 w-3.5 shrink-0" />
                {toggling ? 'Saving...' : 'Enable'}
              </button>
            )}
            {/* Rotate session */}
            <button
              className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text"
              onClick={() => {
                setMenuOpen(false);
                confirmRotateSession();
              }}
            >
              <RotateCcw className="h-3.5 w-3.5 shrink-0" />
              Rotate session
            </button>
            {/* Restart — recovery for a hung agent. Provider failures suppress
                this action because restart is not the remedy for account,
                quota, or provider retry problems. Auth failures get an in-app
                settings action; quota/rate guidance stays in the health banner.
                Greyed when disabled: a
                disabled agent has nothing running to restart. The 409 backstop
                still surfaces in the confirm modal if state changes under us. */}
            {providerAction ? (
              <button
                className="flex min-h-[44px] w-full items-start gap-2.5 px-3 py-2 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text"
                onClick={() => {
                  setMenuOpen(false);
                  goToProviderSettings();
                }}
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-health-error" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-text">{providerAction.label}</span>
                  <span className="mt-0.5 text-[11px] leading-tight text-text-muted">
                    {providerAction.description}
                  </span>
                </span>
              </button>
            ) : restartBlocked ? null : (
              <button
                disabled={!enabled}
                title={!enabled ? 'Agent is disabled. Enable it to run.' : undefined}
                className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                onClick={() => {
                  setMenuOpen(false);
                  confirmRestart();
                }}
              >
                <RefreshCw className="h-3.5 w-3.5 shrink-0" />
                Restart agent
              </button>
            )}
            <button
              disabled={copyingDiagnostics}
              className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text disabled:opacity-50"
              onClick={() => {
                void copyDiagnostics();
              }}
            >
              {diagnosticsCopied ? (
                <ClipboardCheck className="h-3.5 w-3.5 shrink-0 text-health-ok" />
              ) : (
                <Clipboard className="h-3.5 w-3.5 shrink-0" />
              )}
              {diagnosticsCopied ? 'Copied' : 'Copy diagnostics'}
            </button>
            {/* Divider */}
            <div className="my-1 h-px bg-border-soft" />
            {/* Remove agent — destructive, bottom */}
            <button
              className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-health-error hover:bg-health-error-soft"
              onClick={() => {
                setMenuOpen(false);
                confirmRemove();
              }}
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Remove agent
            </button>
          </div>
        )}
      </div>

      {/* Single confirm modal instance, driven by the useConfirm hook */}
      {modal}
    </>
  );
}
