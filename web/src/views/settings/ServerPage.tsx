import { useQuery } from '@tanstack/react-query';
import { fetchServerInfo, pingHealth } from '@/api/system';
import { shortIso, formatUptime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { useNow } from '@/hooks/useNow';
import RestartButton from '@/components/RestartButton';
import RuntimeUpgradeRow from '@/components/RuntimeUpgrade';

/**
 * Server settings page — the static server-identity facts. Provider usage has
 * its own page (Providers); what remains is a status hero plus a key-value meta
 * list:
 *
 *   Status hero — health + uptime, with Restart as the hero action
 *   Version     — track · version (embeds the commit SHA) + the update check
 *   Home        — the ANIMA_HOME path
 *
 * New facts join the meta list as another <MetaRow>; whole new concerns get
 * their own bordered section under the hero.
 *
 * This used to be a portal dialog (`ServerPanel`). The settings shell now owns
 * the chrome (title, back, focus, URL); this component is only the content.
 * The do-not-contact list that sat between the hero and the meta list moved to
 * its own Policies page (Outreach limits).
 */
export default function ServerPage() {
  // --- Server info ---
  const { data: healthOk } = useQuery({
    queryKey: queryKeys.health(),
    queryFn: pingHealth,
    staleTime: 5_000,
  });
  const { data: info } = useQuery({
    queryKey: queryKeys.serverInfo(),
    queryFn: fetchServerInfo,
    staleTime: 60_000,
  });
  const health: 'loading' | 'ok' | 'error' =
    healthOk === undefined ? 'loading' : healthOk ? 'ok' : 'error';

  // Ticks every minute — keeps uptime current.
  const now = useNow();

  const healthColor =
    health === 'loading'
      ? 'var(--color-health-idle)'
      : health === 'ok'
        ? 'var(--color-health-ok)'
        : 'var(--color-health-error)';
  const healthLabel =
    health === 'loading' ? 'Checking…' : health === 'ok' ? 'Healthy' : 'Unreachable';

  // One "which build" line: track folded in front of the version, which already
  // embeds the commit SHA (so no separate Commit row). e.g. "canary · 0.1.1-canary.75.1.80810fb".
  const version = info?.version && info.version !== '0.0.0' ? info.version : null;
  const buildLine = version
    ? info?.track
      ? `${info.track} · ${version}`
      : version
    : (info?.track ?? null);

  // Wait for both health and server info before revealing the card.
  const isReady = healthOk !== undefined && !!info;

  return (
    <div
      className={[
        'divide-y divide-border-soft transition-opacity duration-150 ease-out',
        isReady ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
    >
          {/* Status hero — health + uptime; Restart is the hero action */}
          <div className="flex items-start justify-between gap-4 py-5">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: healthColor }}
                />
                <span className="font-serif text-[18px] font-semibold text-text">
                  {healthLabel}
                </span>
              </div>
              {info?.startedAt && (
                <div
                  className="pl-[18px] font-sans text-[11px] tracking-wide text-text-subtle"
                  title={shortIso(info.startedAt)}
                >
                  up {formatUptime(info.startedAt, now)}
                </div>
              )}
            </div>
            <RestartButton compact />
          </div>

          {/* Meta — Version + Home as a key-value list. Extend with more rows. */}
          <div className="py-5">
            <dl className="grid grid-cols-[72px_1fr] gap-x-4 gap-y-5">
              <MetaRow label="Version">
                {buildLine && (
                  <div className="min-w-0 break-all font-mono text-[12px] text-text">
                    {buildLine}
                  </div>
                )}
                <div className={buildLine ? 'mt-2' : ''}>
                  <RuntimeUpgradeRow />
                </div>
              </MetaRow>
              {info && (
                <MetaRow label="Home">
                  <div
                    className="min-w-0 break-all font-mono text-[12px] text-text"
                    title={info.animaHome}
                  >
                    {info.animaHome}
                  </div>
                </MetaRow>
              )}
            </dl>
          </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

/** One key-value row in the meta list: uppercase label left, value right. */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="pt-0.5 font-sans text-[10px] font-medium uppercase tracking-widest text-text-subtle">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
