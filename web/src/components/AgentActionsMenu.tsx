/**
 * ⋯ overflow menu for per-agent lifecycle actions — Disable/Enable, Rotate
 * session, Remove agent. Used in both AgentHeader (desktop) and MobileTopBar.
 *
 * Renders the trigger button inline; confirm overlay modals use `fixed` so
 * they appear above everything regardless of containing context.
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Clipboard,
  ClipboardCheck,
  ExternalLink,
  MoreHorizontal,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  disableAgent,
  enableAgent,
  fetchAgentDiagnostics,
  fetchAgentStatuses,
  fetchAgents,
  removeAgent,
  restartAgent,
  rotateAgentSession,
  refreshDashboardData,
} from '@/api/agents';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from './ui/button';
import {
  agentHealthBlocksRestart,
  agentHealthProviderAction,
  agentHealthSummaryText,
} from './AgentHealthIndicator';
import { useConfirm } from '@/hooks/useConfirm';
import { formatAgentDiagnostics } from '@/lib/diagnostics';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';



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
  const { data: statuses = [] } = useQuery({
    queryKey: queryKeys.agentStatuses(),
    queryFn: fetchAgentStatuses,
    refetchInterval: refetchIntervals.agentStatuses,
  });
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { confirm, modal } = useConfirm();

  const [menuOpen, setMenuOpen] = useState(false);
  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
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

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  if (!agentId) return null;
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return null;
  const enabled = agent.enabled !== false;
  // A non-empty Feishu appId means the user created a Feishu bot app during
  // onboarding. Removing the agent wipes the local config (appId included) but
  // cannot delete the app on Feishu's side — there is no API for that — so the
  // remove dialog surfaces a deep-link to that exact app's console page.
  // Route the console domain by tenant brand silently (never shown to the user);
  // the visible label always says "Feishu console" per our copy red line.
  const feishuAppId = agent.feishu?.appId?.trim();
  const feishuConsoleUrl = feishuAppId
    ? `https://${
        agent.feishu?.ownerTenantBrand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'
      }/app/${encodeURIComponent(feishuAppId)}`
    : undefined;
  const status = statuses.find((candidate) => candidate.agentId === agentId);
  const running = Boolean(status?.currentItemId);
  const health = status?.health;
  const healthSummary = agentHealthSummaryText(health);
  const providerAction = agentHealthProviderAction(health);
  const restartBlocked = agentHealthBlocksRestart(health);

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

  async function handleCopyDiagnostics() {
    if (!agentId || copyingDiagnostics) return;
    setCopyingDiagnostics(true);
    try {
      const diagnostics = await fetchAgentDiagnostics(agentId);
      await writeClipboard(formatAgentDiagnostics(diagnostics));
      setDiagnosticsCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        setDiagnosticsCopied(false);
        copiedTimerRef.current = null;
      }, 2500);
    } catch (error) {
      console.error('[AgentActionsMenu] failed to copy diagnostics', error);
    } finally {
      setCopyingDiagnostics(false);
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
              running ? (
                <div
                  role="menuitem"
                  aria-disabled="true"
                  title="Agent is running. Stop the agent before disabling."
                  className="flex min-h-[44px] w-full cursor-not-allowed items-start gap-2.5 px-3 py-2 text-left font-sans text-[13px] text-text-muted opacity-50"
                >
                  <PowerOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-col">
                    <span>Disable</span>
                    <span className="mt-0.5 text-[11px] leading-tight">
                      Agent is running. Stop the agent before disabling.
                    </span>
                  </span>
                </div>
              ) : (
                <button
                  disabled={toggling}
                  className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text disabled:opacity-50"
                  onClick={() => {
                    setMenuOpen(false);
                    void handleToggleEnabled(false);
                  }}
                >
                  <PowerOff className="h-3.5 w-3.5 shrink-0" />
                  {toggling ? 'Saving...' : 'Disable'}
                </button>
              )
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
                  description: 'The current work keeps running. Future work starts fresh, and the current provider session is archived.',
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
                  navigate(`/agents/${agentId}/profile`);
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
                  confirm({
                    title: 'Restart this agent?',
                    description: (
                      <>
                        Use this only if the agent is hung. It will be forced to stop and start over
                        immediately. Any current work is dropped and is not retried, so re-run it
                        manually afterward. Memory, notes, and config are kept; queued work stays
                        queued.
                        {healthSummary && (
                          <span className="mt-2 block font-sans text-[12px] text-text-muted">
                            Current health: {healthSummary}
                          </span>
                        )}
                      </>
                    ),
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
            )}
            <button
              disabled={copyingDiagnostics}
              className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[13px] text-text-muted hover:bg-surface-elevated hover:text-text disabled:opacity-50"
              onClick={() => {
                void handleCopyDiagnostics();
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
                confirm({
                  title: 'Remove this agent?',
                  description: feishuConsoleUrl ? (
                    <>
                      <p>
                        The agent will stop running and its local Anima config will be deleted. Home
                        files are not affected.
                      </p>
                      <p className="mt-2">
                        {"Removing this agent won't delete the Feishu bot you created. To remove it completely, delete the app in the Feishu console."}
                      </p>
                      <a
                        href={feishuConsoleUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1 font-sans text-[13px] text-text underline decoration-text-subtle/40 underline-offset-2 transition-colors hover:decoration-text/40"
                      >
                        Open this app in the Feishu console
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      </a>
                    </>
                  ) : (
                    'The agent will stop running and its local Anima config will be deleted. Home files are not affected.'
                  ),
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

async function writeClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the local textarea fallback when browser permissions
      // reject the async clipboard API.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}
