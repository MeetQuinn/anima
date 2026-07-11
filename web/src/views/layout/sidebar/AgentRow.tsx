import { agentColor, initialOf } from '@/lib/avatars';
import { agentAvatarUrl, agentDisplayName } from '@/lib/agent-avatar';
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
  touch = false,
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
  // Touch surfaces (MobileNavScreen) get taller rows, slightly larger type, and
  // left padding that clears the always-visible drag grip. Colors are shared:
  // both surfaces sit on the dark spine.
  touch?: boolean;
}) {
  const color = agentColor(index);
  const displayName = agentDisplayName(agent);
  const avatarUrl = agentAvatarUrl(agent);
  const initial = initialOf(displayName);
  // Connected is transport-level: Slack or Feishu credentials can make an
  // agent reachable. Raw secrets are redacted on the wire, so use the derived
  // connected flags instead of token fields.
  const notConnected = enabled && !agentHasConnectedTransport(agent);
  const showRuntimeHealth = enabled && !notConnected;
  const hasRightMeta = !enabled || showRuntimeHealth;
  const dotBg = sidebarDotColor(status?.health, isRunning);
  const dotTitle = sidebarDotTitle(status?.health, isRunning);
  // Active row: the avatar picks up a faint accent ring (in addition to the
  // rounded-cap accent bar) so selection reads without shouting.
  const avatarRing = active ? 'ring-accent/40' : 'ring-avatar-ring-spine';
  return (
    <div
      {...(optionId ? { id: optionId, role: 'option', 'aria-selected': active } : {})}
      className={[
        'group relative flex w-full items-center rounded-sm transition-colors',
        // Active: solid elevated bg; hover: much lighter so selected is unambiguous
        active ? 'bg-spine-elevated' : 'hover:bg-spine-elevated/30',
      ].join(' ')}
    >
      {(active || focused) && (
        // Left accent bar marks both the committed selection and the keyboard
        // cursor. Showing it for `focused` gives instant feedback as you arrow
        // (the active bg/bar commit lags ~120ms behind the cursor), replacing
        // the full inset ring that read as too loud on the dark spine.
        <span aria-hidden className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent" />
      )}
      <button
        onClick={onClick}
        // Inside the listbox the container owns keyboard focus (single tab
        // stop); rows are reachable by arrows, not Tab. Mouse clicks still work.
        {...(optionId ? { tabIndex: -1 } : {})}
        className={[
          'flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left focus-visible:outline-none',
          touch ? 'min-h-[44px] py-3 pl-6 pr-3' : 'px-3 py-2.5',
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
              'h-8 w-8 shrink-0 rounded-lg object-cover ring-1',
              avatarRing,
              !enabled ? 'opacity-40 grayscale' : notConnected ? 'opacity-40 grayscale' : '',
            ].join(' ')}
          />
        ) : (
          <span
            className={[
              'font-sans flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white ring-1',
              avatarRing,
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
                'min-w-0 flex-1 truncate font-serif leading-tight',
                touch ? 'text-[15px]' : 'text-[14px]',
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
                  // is the sidebar's only ambient signal. A working (running)
                  // agent's dot breathes with a soft halo so live work reads at
                  // a glance; every other state holds still.
                  isRunning ? (
                    <span aria-hidden className="relative flex h-2 w-2 shrink-0 items-center justify-center" title={dotTitle}>
                      <span className="anima-dot-halo absolute h-2 w-2 rounded-full" style={{ background: dotBg }} />
                      <span className="anima-dot-core relative h-2 w-2 rounded-full" style={{ background: dotBg }} />
                    </span>
                  ) : (
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      title={dotTitle}
                      style={{ background: dotBg }}
                    />
                  )
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
