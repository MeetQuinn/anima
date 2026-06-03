import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, LoaderCircle } from 'lucide-react';
import type {
  AgentHealthReason,
  AgentRuntimeHealthSummary,
} from '@shared/snapshot';

const RECOVERED_ACK_MS = 2_500;
const STARTING_MIN_DISPLAY_MS = 600;

type Surface = 'spine' | 'surface';
type Density = 'row' | 'header';

export function AgentHealthIndicator({
  health,
  isRunning,
  surface = 'surface',
  density = 'row',
}: {
  health?: AgentRuntimeHealthSummary;
  isRunning: boolean;
  surface?: Surface;
  density?: Density;
}) {
  const { holdStarting, now } = useHealthDisplayClock(health);
  const display = healthDisplay(health, isRunning, now, holdStarting);
  const textColor = surface === 'spine' ? 'text-text-on-spine-subtle' : 'text-text-muted';
  const recoveredStyle = display.kind === 'recovered'
    ? { color: 'var(--color-health-ok)' }
    : undefined;
  const labelClass = [
    'font-sans text-[9px] uppercase tracking-[0.08em]',
    display.kind === 'unhealthy'
      ? 'text-health-error'
      : display.kind === 'recovered'
        ? ''
        : textColor,
  ].join(' ');
  const iconClass = display.kind === 'unhealthy'
    ? 'text-health-error'
    : display.kind === 'recovered'
      ? ''
      : textColor;

  if (display.kind === 'healthy') {
    return (
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{
          background: isRunning ? 'var(--color-health-warn)' : 'var(--color-health-ok)',
        }}
        title={isRunning ? 'working' : 'idle'}
      />
    );
  }

  const showText = density === 'header' || display.kind !== 'unknown' || surface !== 'spine';
  const Icon = display.icon;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      title={display.title}
      aria-label={display.title}
    >
      {Icon ? (
        <Icon
          aria-hidden
          className={[
            'h-3 w-3',
            display.kind === 'starting' ? 'animate-spin' : '',
            iconClass,
          ].join(' ')}
          style={recoveredStyle}
        />
      ) : null}
      {showText && (
        <span className={labelClass} style={recoveredStyle}>
          {display.label}
        </span>
      )}
    </span>
  );
}

export function agentHealthReasonText(reason: AgentHealthReason | undefined): string {
  switch (reason) {
    case 'provider_child_missing':
      return 'The agent stopped running. Restart the agent.';
    case 'provider_child_exited':
      return 'The agent stopped unexpectedly. Restart the agent.';
    case 'restart_failed':
      return 'Restart failed. Try again or check the logs.';
    case 'restart_pending':
      return 'Restart pending.';
    case 'stale_running_item':
      return "The agent's current work has stalled. Restart the agent.";
    case 'start_failed':
      return "The agent couldn't start. Check its settings, or restart the agent.";
    default:
      return 'Health unavailable.';
  }
}

export function agentHealthSummaryText(health: AgentRuntimeHealthSummary | undefined): string | null {
  if (!health) return null;
  if (agentHealthRecoveredFresh(health, Date.now())) return 'Recovered';
  if (health.state !== 'healthy' && health.restart?.outcome === 'failed') {
    return agentHealthReasonText(health.restart.reason ?? health.reason);
  }
  if (health.state === 'starting') return health.reason === 'restart_pending' ? 'Restart pending' : 'Starting';
  if (health.state === 'unhealthy') return agentHealthReasonText(health.reason);
  if (health.state === 'unknown') return 'Health unavailable';
  return null;
}

function healthDisplay(
  health: AgentRuntimeHealthSummary | undefined,
  isRunning: boolean,
  now: number,
  holdStarting: boolean,
): {
  icon?: typeof AlertTriangle;
  kind: 'healthy' | 'recovered' | 'starting' | 'unhealthy' | 'unknown';
  label: string;
  title: string;
} {
  if (health && agentHealthRecoveredFresh(health, now)) {
    return {
      icon: CheckCircle2,
      kind: 'recovered',
      label: 'Recovered',
      title: 'Recovered',
    };
  }
  if (holdStarting) {
    return {
      icon: LoaderCircle,
      kind: 'starting',
      label: 'Starting',
      title: 'Starting',
    };
  }
  if (!health) {
    return {
      icon: CircleDashed,
      kind: 'unknown',
      label: 'Health unavailable',
      title: 'Health unavailable',
    };
  }
  if (health.state === 'starting') {
    return {
      icon: LoaderCircle,
      kind: 'starting',
      label: health.reason === 'restart_pending' ? 'Restarting' : 'Starting',
      title: health.reason === 'restart_pending' ? 'Restart pending' : 'Starting',
    };
  }
  if (health.state === 'unhealthy' || (health.state !== 'healthy' && health.restart?.outcome === 'failed')) {
    const reason = health.restart?.outcome === 'failed'
      ? health.restart.reason ?? health.reason
      : health.reason;
    return {
      icon: AlertTriangle,
      kind: 'unhealthy',
      label: 'Needs attention',
      title: agentHealthReasonText(reason),
    };
  }
  if (health.state === 'unknown') {
    return {
      icon: CircleDashed,
      kind: 'unknown',
      label: 'Health unavailable',
      title: 'Health unavailable',
    };
  }
  return {
    kind: 'healthy',
    label: isRunning ? 'Working' : 'Idle',
    title: isRunning ? 'working' : 'idle',
  };
}

export function agentHealthRecoveredFresh(health: AgentRuntimeHealthSummary, now: number): boolean {
  if (health.state !== 'healthy') return false;
  if (health.restart?.outcome !== 'recovered' || !health.restart.completedAt) return false;
  const completedAt = Date.parse(health.restart.completedAt);
  return Number.isFinite(completedAt) && now - completedAt < RECOVERED_ACK_MS;
}

function useHealthDisplayClock(health: AgentRuntimeHealthSummary | undefined): {
  holdStarting: boolean;
  now: number;
} {
  const [now, setNow] = useState(() => Date.now());
  const [startingSince, setStartingSince] = useState<number | null>(() =>
    health?.state === 'starting' ? healthTimestamp(health.updatedAt) : null,
  );
  const isStarting = health?.state === 'starting';

  useEffect(() => {
    if (isStarting) {
      const timestamp = healthTimestamp(health?.updatedAt) ?? Date.now();
      const timer = setTimeout(() => {
        setStartingSince((previous) => previous ?? timestamp);
        setNow(Date.now());
      }, 0);
      return () => clearTimeout(timer);
    }
    if (startingSince === null) return;
    const remaining = Math.max(0, startingSince + STARTING_MIN_DISPLAY_MS - Date.now());
    const timer = setTimeout(() => {
      setStartingSince(null);
      setNow(Date.now());
    }, remaining);
    return () => clearTimeout(timer);
  }, [health?.updatedAt, isStarting, startingSince]);

  useEffect(() => {
    if (health?.restart?.outcome !== 'recovered' || !health.restart.completedAt) return;
    const completedAt = Date.parse(health.restart.completedAt);
    if (!Number.isFinite(completedAt)) return;
    const remaining = Math.max(0, RECOVERED_ACK_MS - (Date.now() - completedAt));
    if (remaining === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [health?.restart?.completedAt, health?.restart?.outcome]);

  useEffect(() => {
    if (!isStarting) return;
    const timer = setTimeout(() => setNow(Date.now()), STARTING_MIN_DISPLAY_MS);
    return () => clearTimeout(timer);
  }, [isStarting]);

  return {
    holdStarting: isStarting || (
      startingSince !== null && now < startingSince + STARTING_MIN_DISPLAY_MS
    ),
    now,
  };
}

function healthTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
