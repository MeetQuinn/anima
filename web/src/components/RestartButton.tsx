import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { fetchAgents, fetchAgentStatuses } from '@/api/agents';
import { pingHealth, restartServices } from '@/api/system';
import { queryKeys } from '@/lib/query-keys';
import { BusyConfirmModal } from './restart-shared';

type Phase = 'idle' | 'restarting' | 'recovered' | 'failed';

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;

export default function RestartButton({ compact = false }: { compact?: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef<number>(0);
  const { data: agents = [] } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const { data: agentStatuses = [] } = useQuery({ queryKey: queryKeys.agentStatuses(), queryFn: fetchAgentStatuses });

  // Drain mode coordinates only the RUNNING agents (mid-item) — queued items
  // are left untouched for the new worker, so they're not blockers and don't
  // belong in the confirm. Re-derived each render until the user clicks, so the
  // decision reflects the most current state (agentStatuses polls every 5s).
  const runningNames = computeRunningAgentNames(agents, agentStatuses);

  function requestRestart() {
    if (phase !== 'idle') return;
    // All idle → nothing to interrupt, just go (no modal). Agents working →
    // confirm with continuity copy naming them.
    if (runningNames.length > 0) {
      setConfirmOpen(true);
    } else {
      void performRestart();
    }
  }

  async function performRestart() {
    setConfirmOpen(false);
    setError(null);
    try {
      await restartServices();
      startedAt.current = Date.now();
      setPhase('restarting');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('failed');
    }
  }

  useEffect(() => {
    if (phase !== 'restarting') return;
    let sawDown = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (Date.now() - startedAt.current > HEALTH_TIMEOUT_MS) {
        setError('Restart timed out after 30s. Check logs.');
        setPhase('failed');
        return;
      }
      const ok = await pingHealth();
      if (!ok) {
        sawDown = true;
      } else if (sawDown) {
        // Only treat health as "recovered" once we've observed the
        // web app go down — otherwise we're seeing the pre-restart
        // web app still answering and would skip the actual restart.
        setPhase('recovered');
        window.location.reload();
        return;
      }
      timeoutId = setTimeout(tick, HEALTH_POLL_INTERVAL_MS);
    }

    timeoutId = setTimeout(tick, HEALTH_POLL_INTERVAL_MS);
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [phase]);

  return (
    <>
      {compact ? (
        /* Compact variant — icon + label, right-aligned in a row.
           Used by ServerPanel to keep the trigger away from the sidebar
           footer Server button. All modal/overlay/polling logic unchanged. */
        <button
          onClick={requestRestart}
          disabled={phase === 'restarting'}
          className={[
            'flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] transition-colors',
            phase === 'restarting'
              ? 'cursor-wait text-text-on-spine-subtle'
              : 'cursor-pointer border border-spine-border/60 text-text-on-spine-muted hover:border-spine-border hover:text-text-on-spine focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
          ].join(' ')}
          title={phase === 'failed' && error ? error : 'Restart Anima services'}
        >
          <RefreshCw className={`h-2.5 w-2.5 ${phase === 'restarting' ? 'animate-spin' : ''}`} />
          <span>{phase === 'restarting' ? 'Restarting…' : 'Restart'}</span>
        </button>
      ) : (
        /* Default variant — full-width chrome bar (sidebar footer). */
        <>
          <button
            onClick={requestRestart}
            disabled={phase === 'restarting'}
            className={[
              'chrome flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-[11px] uppercase tracking-[0.1em] transition-colors',
              phase === 'restarting'
                ? 'cursor-wait text-text-on-spine-subtle'
                : 'cursor-pointer text-text-on-spine-muted hover:bg-spine-elevated hover:text-text-on-spine focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            ].join(' ')}
            title="Restart Anima services"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${phase === 'restarting' ? 'animate-spin' : ''}`} />
            <span>{phase === 'restarting' ? 'Restarting…' : 'Restart services'}</span>
          </button>
          {phase === 'failed' && error && (
            <div className="mt-1 px-2 text-[11px] text-health-error">{error}</div>
          )}
        </>
      )}
      {confirmOpen && (
        <BusyConfirmModal
          kind="restart"
          runningNames={runningNames}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void performRestart()}
        />
      )}
      {phase === 'restarting' && <RestartOverlay />}
    </>
  );
}

// "Running" = an agent actively processing an item (has a currentItemId).
// Queued-but-not-running agents are intentionally excluded: drain mode leaves
// queued work for the new worker, so they're not interrupted and shouldn't
// appear in the confirm.
function computeRunningAgentNames(
  agents: { id: string; profile?: { displayName?: string } }[],
  agentStatuses: { agentId: string; currentItemId?: string }[],
): string[] {
  const nameById = new Map(agents.map((a) => [a.id, a.profile?.displayName ?? a.id]));
  const running: string[] = [];
  for (const status of agentStatuses) {
    if (status.currentItemId) {
      running.push(nameById.get(status.agentId) ?? status.agentId);
    }
  }
  return running;
}

function RestartOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm">
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-sm border border-border-soft bg-surface px-10 py-7 text-center shadow-deep">
        <RefreshCw className="h-6 w-6 animate-spin text-accent" />
        <div className="font-serif text-[16px] font-medium text-text">
          Restarting Anima services…
        </div>
        {/* Continuity-first + honest about the best-effort safe point (v1 never
            force-kills a tool mid-flight — it drains to a clean edge or waits). */}
        <div className="font-sans text-[12px] leading-relaxed text-text-muted">
          Any working agents pause at a safe point and resume right where they left off. The web app
          reloads automatically when services are back.
        </div>
      </div>
    </div>
  );
}
