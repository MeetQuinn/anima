/**
 * ⋯ overflow menu for per-agent lifecycle actions — Disable/Enable, Rotate
 * session, Remove agent. Used in both AgentHeader (desktop) and MobileTopBar.
 *
 * Renders the trigger button inline; confirm overlay modals use `fixed` so
 * they appear above everything regardless of containing context.
 */
import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Power, PowerOff, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { disableAgent, enableAgent, removeAgent, restartAgent, rotateAgentSession, fetchAgents, refreshDashboardData } from '@/api/agents';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from './ui/button';
import { useConfirm } from '@/hooks/useConfirm';
import { queryKeys } from '@/lib/query-keys';



// ── AgentActionsMenu ──────────────────────────────────────────────────────────

/**
 * The ⋯ overflow menu for lifecycle actions. Renders a button + dropdown +
 * confirm overlay modals. Drop it anywhere in the header — the modals float
 * via fixed positioning.
 *
 * `buttonClassName` lets callers tweak sizing for desktop vs mobile contexts.
 */
export default function AgentActionsMenu({ buttonClassName }: { buttonClassName?: string }) {
  const { data: agents = [] } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const { confirm, modal } = useConfirm();

  const [menuOpen, setMenuOpen] = useState(false);
  const [toggling, setToggling] = useState(false);

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

  if (!agentId) return null;
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const enabled = agent.enabled !== false;

  async function handleToggleEnabled(nextEnabled: boolean) {
    if (!agentId || toggling) return;
    setToggling(true);
    try {
      await (nextEnabled ? enableAgent(agentId) : disableAgent(agentId));
      refreshDashboardData();
    } catch {
      // Error is surfaced by the caller if needed; this path is for the
      // instant enable case that skips the confirm modal.
    } finally {
      setToggling(false);
    }
  }

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
            {/* Disable / Enable — top, state-labeled, frequent + reversible */}
            {enabled ? (
              <button
                className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text"
                onClick={() => {
                  setMenuOpen(false);
                  confirm({
                    title: 'Disable this agent?',
                    description: 'If it is running now, it will stop after the current item finishes. Memory and session are preserved.',
                    variant: 'error',
                    confirmLabel: 'Disable',
                    busyLabel: 'Saving...',
                    onConfirm: async () => {
                      await disableAgent(agentId);
                      refreshDashboardData();
                    },
                  });
                }}
              >
                <PowerOff className="h-3.5 w-3.5 shrink-0" />
                Disable when idle
              </button>
            ) : (
              <button
                disabled={toggling}
                className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text disabled:opacity-50"
                onClick={() => {
                  setMenuOpen(false);
                  void handleToggleEnabled(true);
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
                confirm({
                  title: 'Rotate primary session?',
                  description: 'The current item keeps running. The next item starts fresh, and the current provider session is archived.',
                  variant: 'warn',
                  confirmLabel: 'Confirm',
                  busyLabel: 'Rotating…',
                  onConfirm: async () => {
                    await rotateAgentSession(agentId);
                    refreshDashboardData();
                  },
                });
              }}
            >
              <RotateCcw className="h-3.5 w-3.5 shrink-0" />
              Rotate session
            </button>
            {/* Restart — recovery for a hung agent. Greyed when disabled: a
                disabled agent has nothing running to restart. The 409 backstop
                still surfaces in the confirm modal if state changes under us. */}
            <button
              disabled={!enabled}
              title={!enabled ? 'Agent is disabled. Enable it to run.' : undefined}
              className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted"
              onClick={() => {
                setMenuOpen(false);
                confirm({
                  title: 'Restart this agent?',
                  description:
                    'Use this only if the agent is hung. It will be forced to stop and start over immediately. Any item it is working on right now is dropped and is not retried, so re-run it manually afterward. Memory, notes, and config are kept; queued items stay queued.',
                  variant: 'warn',
                  confirmLabel: 'Restart',
                  busyLabel: 'Restarting…',
                  onConfirm: async () => {
                    await restartAgent(agentId);
                    refreshDashboardData();
                  },
                });
              }}
            >
              <RefreshCw className="h-3.5 w-3.5 shrink-0" />
              Restart agent
            </button>
            {/* Divider */}
            <div className="my-1 h-px bg-border-soft" />
            {/* Remove agent — destructive, bottom */}
            <button
              className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-health-error hover:bg-health-error-soft"
              onClick={() => {
                setMenuOpen(false);
                confirm({
                  title: 'Remove this agent?',
                  description: 'The agent will stop running and its local Anima config will be deleted. Home files are not affected.',
                  variant: 'error',
                  confirmLabel: 'Remove',
                  busyLabel: 'Removing…',
                  confirmVariant: 'destructive',
                  onConfirm: async () => {
                    await removeAgent(agentId);
                    navigate('/');
                  },
                });
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
