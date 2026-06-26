import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { stopItem, fetchAgents, fetchAgentStatuses, refreshDashboardData } from '@/api/agents';
import { useParams } from 'react-router-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { parseLocation, AGENT_TABS, DEFAULT_TAB, type AgentTab } from '@/lib/url-state';
import { agentColor, initialOf } from '@/lib/avatars';
import { agentAvatarUrl, agentDisplayName } from '@/lib/agent-avatar';
import { Button } from './ui/button';
import AgentActionsMenu from './AgentActionsMenu';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useActivityFilters } from '@/hooks/useActivityFilters';

const TABS: { id: AgentTab; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'channels', label: 'Channels' },
  { id: 'profile', label: 'Profile' },
  { id: 'reminders', label: 'Reminders' },
];

function FilterToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="chrome inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-[11px] tracking-wide text-text-muted hover:text-text">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-[color:var(--color-accent)]"
      />
      {label}
    </label>
  );
}

export default function AgentHeader() {
  const { data: agents = [] } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const { data: agentStatuses = [] } = useQuery({
    queryKey: queryKeys.agentStatuses(),
    queryFn: fetchAgentStatuses,
    refetchInterval: refetchIntervals.agentStatuses,
  });
  const { agentId } = useParams<{ agentId: string }>();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { tab: parsedTab } = parseLocation(pathname);
  const tab: AgentTab = parsedTab && AGENT_TABS.includes(parsedTab) ? parsedTab : DEFAULT_TAB;
  const setTab = (next: AgentTab) => {
    if (!agentId) return;
    navigate(`/agents/${agentId}/${next}`);
  };
  const { failedOnly, showToolSteps, setFailedOnly, setShowToolSteps } =
    useActivityFilters();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  if (!agentId) return null;

  const idx = agents.findIndex((a) => a.id === agentId);
  const agent = idx >= 0 ? agents[idx]! : undefined;
  if (!agent) return null;

  const color = agentColor(idx);
  const displayName = agentDisplayName(agent);
  const avatarUrl = agentAvatarUrl(agent);
  const role = agent.profile?.role;
  const initial = initialOf(displayName);
  const status = agentStatuses.find((s) => s.agentId === agent.id);
  const currentItemId = status?.currentItemId;
  const handleStop = async () => {
    if (!currentItemId || stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await stopItem(agent.id);
      refreshDashboardData();
    } catch (error) {
      setStopError(error instanceof Error ? error.message : 'Stop failed');
    } finally {
      setStopping(false);
    }
  };

  // Agent masthead — display Fraunces for the name, sans role, generous
  // height. Tabs underneath use accent for the active rule (the one accent the
  // header is allowed; activity dots and pills don't fight it).
  return (
    <header className="bg-surface">
      <div className="hidden h-14 items-center gap-3 border-b border-border-soft px-8 md:flex">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-7 w-7 shrink-0 rounded-lg object-cover ring-1 ring-border-soft"
          />
        ) : (
          <span
            className="font-sans flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white ring-1 ring-border-soft"
            style={{ background: color }}
          >
            {initial}
          </span>
        )}
        <span className="display truncate text-[20px] font-semibold leading-tight text-text">
          {displayName}
        </span>
        {role && (
          <span
            className="font-sans truncate text-[12px] tracking-wide text-text-muted"
            title={role}
          >
            {role}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {currentItemId && (
            <>
              <Button
                variant="outline"
                size="xs"
                onClick={handleStop}
                disabled={stopping}
                title="Stop current work"
              >
                {stopping ? 'Stopping…' : 'Stop'}
              </Button>
              {stopError && (
                <span className="font-sans text-[11px] text-health-error">{stopError}</span>
              )}
            </>
          )}
          <AgentActionsMenu />
        </div>
      </div>
      <nav className="hidden flex-wrap items-center gap-y-1 border-b border-border-soft px-8 md:flex">
        <div className="flex flex-1 items-center gap-1">
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={[
                  'chrome relative -mb-px border-b-2 px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.12em] transition-colors',
                  active
                    ? 'border-accent text-text'
                    : 'border-transparent text-text-muted hover:text-text',
                ].join(' ')}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {tab === 'activity' && (
          <div className="flex shrink-0 items-center gap-3">
            <FilterToggle label="Failed only" checked={failedOnly} onChange={setFailedOnly} />
            <FilterToggle
              label="Show tool steps"
              checked={showToolSteps}
              onChange={setShowToolSteps}
            />
          </div>
        )}
      </nav>
    </header>
  );
}
