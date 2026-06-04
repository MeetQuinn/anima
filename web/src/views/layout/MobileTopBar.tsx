import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { parseLocation } from '@/lib/url-state';
import { stopItem, fetchAgents, fetchAgentStatuses, refreshDashboardData } from '@/api/agents';
import { agentColor, initialOf } from '@/lib/avatars';
import AgentActionsMenu from '@/components/AgentActionsMenu';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { agentHasConnectedTransport } from '@shared/agent-transports';

/**
 * Fixed top bar shown on Screen 2 (agent detail) on mobile only.
 * Shows: back arrow → Screen 1, agent avatar + name + liveness dot, stop button.
 * Returns null when there is no selected agent (Screen 1 has its own header).
 *
 * Restart is intentionally omitted here — it is a global service action, not
 * per-agent. On desktop it lives in the sidebar footer (Server button). Mobile
 * users can reach it via the Server panel on the home screen (Screen 1).
 */
export default function MobileTopBar() {
  const { data: agents = [] } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const { data: agentStatuses = [] } = useQuery({
    queryKey: queryKeys.agentStatuses(),
    queryFn: fetchAgentStatuses,
    refetchInterval: refetchIntervals.agentStatuses,
  });
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { agentId } = parseLocation(pathname);
  const setAgentId = (id: string | null) => navigate(id ? `/agents/${id}/activity` : '/');
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  // Screen 1 (no agent selected) uses its own header — hide this bar entirely.
  if (!agentId) return null;

  const idx = agents.findIndex((a) => a.id === agentId);
  const agent = idx >= 0 ? agents[idx] : undefined;
  const status = agentStatuses.find((s) => s.agentId === agentId);
  const currentItemId = status?.currentItemId;

  const displayName = agent?.profile?.displayName?.trim() || agentId;
  const initial = agent ? initialOf(displayName) : '?';
  const color = idx >= 0 ? agentColor(idx) : 'var(--color-health-idle)';
  const enabled = agent?.enabled !== false;
  const connected = agent ? agentHasConnectedTransport(agent) : false;

  const handleStop = async () => {
    if (!currentItemId || stopping || !agentId) return;
    setStopping(true);
    setStopError(null);
    try {
      await stopItem(agentId);
      refreshDashboardData();
    } catch (err) {
      setStopError(err instanceof Error ? err.message : 'Stop failed');
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      className="relative md:hidden"
      style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 40 }}
    >
      <div className="flex h-14 items-center gap-1.5 border-b border-border-soft bg-surface px-2">
        {/* Back to nav list (Screen 1) */}
        <button
          onClick={() => setAgentId(null)}
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-elevated hover:text-text"
          aria-label="Back to agent list"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        {/* Agent avatar — greyscale when not connected, matching desktop sidebar */}
        {agent?.slack?.avatarUrl ? (
          <img
            src={agent.slack.avatarUrl}
            alt=""
            className={['h-6 w-6 shrink-0 rounded-lg object-cover ring-1 ring-border-soft', !connected ? 'opacity-40 grayscale' : ''].join(' ')}
          />
        ) : (
          <span
            className={['font-sans flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-white ring-1 ring-border-soft', !connected ? 'opacity-40' : ''].join(' ')}
            style={{ background: color }}
          >
            {initial}
          </span>
        )}

        {/* Agent name + liveness dot */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="display truncate text-[15px] font-semibold text-text">
            {displayName}
          </span>
          {/* NOT CONNECTED badge — parity with desktop sidebar */}
          {enabled && !connected && (
            <span className="font-sans shrink-0 rounded-sm border border-health-warn/40 px-1 py-0.5 text-[9px] uppercase tracking-[0.08em] text-health-warn">
              Not connected
            </span>
          )}
          {!enabled && (
            <span className="font-sans shrink-0 rounded-sm border border-text-muted/30 px-1 py-0.5 text-[9px] uppercase tracking-[0.08em] text-text-muted">
              Off
            </span>
          )}
        </div>

        {/* Stop — only visible while the agent has active work */}
        {currentItemId && (
          <div className="flex flex-col items-end gap-0.5">
            <button
              onClick={() => void handleStop()}
              disabled={stopping}
              className="chrome rounded-sm border border-border-soft px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-text-muted hover:border-border-strong hover:text-text disabled:opacity-50"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
            {stopError && (
              <span className="font-sans text-[10px] text-health-error">{stopError}</span>
            )}
          </div>
        )}
        {/* ⋯ menu — lifecycle actions on every tab */}
        <AgentActionsMenu buttonClassName="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-elevated hover:text-text" />
      </div>
    </div>
  );
}
