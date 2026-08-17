/**
 * Shared lifecycle-action logic for the current agent — one source of truth
 * behind BOTH surfaces that expose these actions:
 *
 *   - `AgentActionsMenu` (the ⋯ overflow in AgentHeader / MobileTopBar)
 *   - `ProfileActionsRail` (task #185: the big-button rail on desktop Profile)
 *
 * Extracted from AgentActionsMenu verbatim so the two surfaces cannot drift:
 * same gating (Disable while running shows a notice instead of acting, a
 * disabled agent blocks Restart, provider failures suppress Restart), same
 * confirm copy, same refresh side effects. Each consumer renders its own `modal` from useConfirm;
 * two mounted consumers hold independent confirm state, which is correct —
 * a confirm belongs to the surface that launched it.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import {
  disableAgent,
  enableAgent,
  fetchAgentDiagnostics,
  removeAgent,
  restartAgent,
  rotateAgentSession,
  refreshDashboardData,
} from '@/api/agents';
import {
  agentHealthBlocksRestart,
  agentHealthProviderAction,
  agentHealthSummaryText,
} from '@/components/AgentHealthIndicator';
import { useConfirm } from '@/hooks/useConfirm';
import { formatAgentDiagnostics } from '@/lib/diagnostics';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useAgents, useAgentStatuses } from '@/hooks/useAgentDirectory';

export function useAgentActions() {
  const { data: agents = [] } = useAgents();
  const { data: statuses = [] } = useAgentStatuses({ poll: true });
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { confirm, modal } = useConfirm();

  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  const agent = agentId ? agents.find((a) => a.id === agentId) : undefined;
  const enabled = agent ? agent.enabled !== false : true;
  // A non-empty Feishu appId means the user created a Feishu bot app during
  // onboarding. Removing the agent wipes the local config (appId included) but
  // cannot delete the app on Feishu's side — there is no API for that — so the
  // remove dialog surfaces a deep-link to that exact app's console page.
  // Route the console domain by tenant brand silently (never shown to the user);
  // the visible label always says "Feishu console" per our copy red line.
  const feishuAppId = agent?.feishu?.appId?.trim();
  const feishuConsoleUrl = feishuAppId
    ? `https://${
        agent?.feishu?.ownerTenantBrand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'
      }/app/${encodeURIComponent(feishuAppId)}`
    : undefined;
  const status = statuses.find((candidate) => candidate.agentId === agentId);
  const running = Boolean(status?.currentItemId);
  const health = status?.health;
  const healthSummary = agentHealthSummaryText(health);
  const providerAction = agentHealthProviderAction(health);
  const restartBlocked = agentHealthBlocksRestart(health);

  async function toggleEnabled(nextEnabled: boolean) {
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

  // Disable stays clickable while the agent runs (totoday 08-17: 按钮应该一直
  // 可用,点击的时候给个警告); clicking explains instead of a dead greyed
  // control. It NEVER interrupts running work — the server 409s a disable
  // mid-run, and this notice is the honest UI for that boundary.
  function requestDisable() {
    if (!agentId) return;
    if (running) {
      confirm({
        title: 'Agent is running',
        description:
          'Disabling never interrupts work in progress. Wait for the current run to finish, then disable.',
        variant: 'warn',
        confirmLabel: 'OK',
        confirmVariant: 'default',
        hideCancel: true,
        onConfirm: async () => {},
      });
      return;
    }
    void toggleEnabled(false);
  }

  async function copyDiagnostics() {
    if (!agentId || copyingDiagnostics) return;
    setCopyingDiagnostics(true);
    try {
      const diagnostics = await fetchAgentDiagnostics(agentId);
      await copyTextToClipboard(formatAgentDiagnostics(diagnostics));
      setDiagnosticsCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        setDiagnosticsCopied(false);
        copiedTimerRef.current = null;
      }, 2500);
    } catch (error) {
      console.error('[useAgentActions] failed to copy diagnostics', error);
    } finally {
      setCopyingDiagnostics(false);
    }
  }

  function confirmRotateSession() {
    if (!agentId) return;
    confirm({
      title: 'Rotate primary session?',
      description:
        'The current work keeps running. Future work starts fresh, and the current provider session is archived.',
      variant: 'warn',
      confirmLabel: 'Confirm',
      busyLabel: 'Rotating…',
      onConfirm: async () => {
        await rotateAgentSession(agentId);
        refreshDashboardData();
      },
    });
  }

  function confirmRestart() {
    if (!agentId) return;
    confirm({
      title: 'Restart this agent?',
      description: (
        <>
          Use this only if the agent is hung. It will be forced to stop and start over immediately.
          Any current work is dropped and is not retried, so re-run it manually afterward. Memory,
          notes, and config are kept; queued work stays queued.
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
  }

  function confirmRemove() {
    if (!agentId) return;
    confirm({
      title: 'Remove this agent?',
      description: feishuConsoleUrl ? (
        <>
          <p>
            The agent will stop running and its local Anima config will be deleted. Home files are
            not affected.
          </p>
          <p className="mt-2">
            {
              "Removing this agent won't delete the Feishu bot you created. To remove it completely, delete the app in the Feishu console."
            }
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
  }

  function goToProviderSettings() {
    if (!agentId) return;
    navigate(`/agents/${agentId}/profile`);
  }

  return {
    agentId,
    agent,
    enabled,
    running,
    toggling,
    copyingDiagnostics,
    diagnosticsCopied,
    healthSummary,
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
  };
}
