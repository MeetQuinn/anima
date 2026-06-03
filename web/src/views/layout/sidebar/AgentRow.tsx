import { agentColor, initialOf } from '@/lib/avatars';
import { agentHasConnectedTransport, agentTransportLabel } from '@shared/agent-transports';
import type { AgentConfig } from '@shared/agent-config';

// ---------------------------------------------------------------------------
// Agent row — name + status only; actions live on the Profile detail pane.
// ---------------------------------------------------------------------------
export function AgentRow({
  agent,
  index,
  active,
  isRunning,
  enabled,
  onClick,
}: {
  agent: AgentConfig;
  index: number;
  active: boolean;
  isRunning: boolean;
  enabled: boolean;
  onClick: () => void;
}) {
  const color = agentColor(index);
  const displayName = agent.profile?.displayName ?? agent.id;
  const initial = initialOf(displayName);
  // Connected is transport-level: Slack or Feishu credentials can make an
  // agent reachable. Raw secrets are redacted on the wire, so use the derived
  // connected flags instead of token fields.
  const notConnected = enabled && !agentHasConnectedTransport(agent);
  const transportLabel = agentTransportLabel(agent);
  return (
    <div
      className={[
        'group relative flex w-full items-center rounded-sm transition-colors',
        // Active: solid elevated bg; hover: much lighter so selected is unambiguous
        active ? 'bg-spine-elevated' : 'hover:bg-spine-elevated/30',
      ].join(' ')}
    >
      {active && (
        // 2px accent bar — slightly thicker than 1px for clear visibility
        <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-accent" />
      )}
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset"
      >
        {agent.slack?.avatarUrl ? (
          <img
            src={agent.slack.avatarUrl}
            alt=""
            className={[
              'h-8 w-8 shrink-0 rounded-lg object-cover ring-1 ring-avatar-ring-spine',
              !enabled ? 'opacity-40 grayscale' : notConnected ? 'opacity-40 grayscale' : '',
            ].join(' ')}
          />
        ) : (
          <span
            className={[
              'font-sans flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white ring-1 ring-avatar-ring-spine',
              !enabled || notConnected ? 'opacity-40' : '',
            ].join(' ')}
            style={{ background: color }}
          >
            {initial}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={[
                'truncate font-serif text-[14px] leading-tight',
                active ? 'font-semibold' : 'font-medium',
                !enabled || notConnected
                  ? 'text-text-on-spine-subtle'
                  : 'text-text-on-spine',
              ].join(' ')}
            >
              {displayName}
            </span>
            {!enabled ? (
              // OFF badge: pill with background so it reads as a status chip, not bare text
              <span
                className="font-sans ml-auto shrink-0 rounded-sm border border-text-on-spine-subtle/40 bg-text-on-spine-subtle/10 px-1 py-0.5 text-[9px] uppercase tracking-[0.08em] text-text-on-spine-subtle"
                title="disabled by user"
              >
                Off
              </span>
            ) : !notConnected ? (
              <span
                className="ml-auto inline-block h-2 w-2 shrink-0 rounded-full"
                style={{
                  background: isRunning ? 'var(--color-health-warn)' : 'var(--color-health-ok)',
                }}
                title={isRunning ? 'working' : 'idle'}
              />
            ) : null}
          </div>
          {notConnected && (
            <div className="font-sans mt-0.5 text-[10px] leading-tight text-health-warn/80">
              Not connected
            </div>
          )}
          {!notConnected && transportLabel !== 'Slack' && (
            <div className="font-sans mt-0.5 text-[10px] leading-tight text-text-on-spine-subtle">
              {transportLabel}
            </div>
          )}
        </div>
      </button>
    </div>
  );
}
