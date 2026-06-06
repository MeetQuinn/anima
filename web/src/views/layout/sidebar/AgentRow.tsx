import { agentColor, initialOf } from '@/lib/avatars';
import { agentAvatarUrl } from '@/lib/agent-avatar';
import { agentHasConnectedTransport } from '@shared/agent-transports';
import type { AgentConfig } from '@shared/agent-config';
import type { AgentRuntimeHealthSummary, AgentStatusSummary } from '@shared/snapshot';

// ---------------------------------------------------------------------------
// Agent row — name + status only; actions live on the Profile detail pane.
// ---------------------------------------------------------------------------

// Maps health state → a single sidebar dot color. The dot is the only health
// signal in the sidebar; full labels and reason text live in the activity strip.
// Exported so the collapsed avatar rail in Sidebar.tsx can use the same mapping.
export function sidebarDotColor(health: AgentRuntimeHealthSummary | undefined, isRunning: boolean): string {
  if (!health || health.state === 'unknown' || health.state === 'starting' || health.state === 'degraded') {
    return 'var(--color-health-idle)';
  }
  if (health.state === 'unhealthy') return 'var(--color-health-error)';
  return isRunning ? 'var(--color-health-warn)' : 'var(--color-health-ok)';
}

export function sidebarDotTitle(health: AgentRuntimeHealthSummary | undefined, isRunning: boolean): string {
  if (!health || health.state === 'unknown') return 'health unavailable';
  if (health.state === 'starting') return 'starting';
  if (health.state === 'degraded') return 'retrying';
  if (health.state === 'unhealthy') return 'needs attention';
  return isRunning ? 'working' : 'idle';
}

export function AgentRow({
  agent,
  index,
  active,
  isRunning,
  enabled,
  status,
  onClick,
  optionId,
  focused = false,
}: {
  agent: AgentConfig;
  index: number;
  active: boolean;
  isRunning: boolean;
  enabled: boolean;
  status?: AgentStatusSummary;
  onClick: () => void;
  // When rendered inside the keyboard-navigable listbox, the row becomes an
  // ARIA option and `focused` reflects the keyboard cursor. Omitted elsewhere.
  optionId?: string;
  focused?: boolean;
}) {
  const color = agentColor(index);
  const displayName = agent.profile?.displayName ?? agent.id;
  const avatarUrl = agentAvatarUrl(agent);
  const initial = initialOf(displayName);
  // Connected is transport-level: Slack or Feishu credentials can make an
  // agent reachable. Raw secrets are redacted on the wire, so use the derived
  // connected flags instead of token fields.
  const notConnected = enabled && !agentHasConnectedTransport(agent);
  const showRuntimeHealth = enabled && !notConnected;
  const hasRightMeta = !enabled || showRuntimeHealth;
  return (
    <div
      {...(optionId ? { id: optionId, role: 'option', 'aria-selected': active } : {})}
      className={[
        'group relative flex w-full items-center rounded-sm transition-colors',
        // Active: solid elevated bg; hover: much lighter so selected is unambiguous
        active ? 'bg-spine-elevated' : 'hover:bg-spine-elevated/30',
        // Keyboard cursor: inset accent ring, distinct from the active bg/bar so
        // a held arrow shows where you'll land before the commit catches up.
        focused ? 'ring-1 ring-inset ring-accent' : '',
      ].join(' ')}
    >
      {active && (
        // 2px accent bar — slightly thicker than 1px for clear visibility
        <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-accent" />
      )}
      <button
        onClick={onClick}
        // Inside the listbox the container owns keyboard focus (single tab
        // stop); rows are reachable by arrows, not Tab. Mouse clicks still work.
        {...(optionId ? { tabIndex: -1 } : {})}
        className={[
          'flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left focus-visible:outline-none',
          // Inside the listbox the keyboard cursor ring (driven by `focused` on
          // the row container) is the single highlight; the button must not add
          // its own focus-visible ring, which would otherwise linger on a
          // click-focused row after arrow nav moves the active agent away.
          optionId ? '' : 'focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset',
        ].join(' ')}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
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
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={[
                'min-w-0 flex-1 truncate font-serif text-[14px] leading-tight',
                active ? 'font-semibold' : 'font-medium',
                !enabled || notConnected
                  ? 'text-text-on-spine-subtle'
                  : 'text-text-on-spine',
              ].join(' ')}
            >
              {displayName}
            </span>
            {hasRightMeta && (
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {!enabled ? (
                  // OFF badge: pill with background so it reads as a status chip, not bare text
                  <span
                    className="font-sans shrink-0 rounded-sm border border-text-on-spine-subtle/40 bg-text-on-spine-subtle/10 px-1 py-0.5 text-[9px] uppercase tracking-[0.08em] text-text-on-spine-subtle"
                    title="disabled by user"
                  >
                    Off
                  </span>
                ) : showRuntimeHealth ? (
                  // Single colored dot — color encodes all health states.
                  // Labels and reason text live in the activity strip; the dot
                  // is the sidebar's only ambient signal.
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    title={sidebarDotTitle(status?.health, isRunning)}
                    style={{ background: sidebarDotColor(status?.health, isRunning) }}
                  />
                ) : null}
              </span>
            )}
          </div>
          {notConnected && (
            <div className="font-sans mt-0.5 text-[10px] leading-tight text-health-warn/80">
              Not connected
            </div>
          )}
        </div>
      </button>
    </div>
  );
}
