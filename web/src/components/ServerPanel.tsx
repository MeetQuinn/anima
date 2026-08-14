import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { fetchServerInfo, pingHealth } from '@/api/system';
import { shortIso, formatUptime } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { useNow } from '@/hooks/useNow';
import RestartButton from './RestartButton';
import RuntimeUpgradeRow from './RuntimeUpgrade';

interface Props {
  onClose: () => void;
}

/**
 * Server panel — the static server-identity facts. Provider usage moved to its
 * own UsagePanel (see #server-usage-split); what remains is a status hero plus
 * a key-value meta list:
 *
 *   Status hero — health + uptime, with Restart as the hero action
 *   Version     — track · version (embeds the commit SHA) + the update check
 *   Home        — the ANIMA_HOME path
 *
 * New facts join the meta list as another <MetaRow>; whole new concerns get
 * their own bordered section under the hero.
 *
 * Mobile:   full-screen, z-50 (above MobileTopBar/BottomNav at z-40), bg-surface,
 *           safe-area bottom inset, no backdrop.
 * Desktop:  centered dialog, max-w-xl, Esc/click-out to close.
 */
export default function ServerPanel({ onClose }: Props) {
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

  // Focus lifecycle. Both call sites render this as `{open && <ServerPanel/>}`
  // and there is no early return past the dialog, so "mounted" already IS the
  // open state and the hook can be handed the constant.
  //
  // No `initialFocusRef` — deliberately, and not for the AddKbModal reason
  // ("every control belongs to someone else"). This panel owns all three of its
  // controls and NONE of them is a safe landing spot: Close undoes the action
  // that opened the panel, and Restart / the runtime upgrade row are
  // machine-scoped — a keyboard user who opens the panel and presses Enter would
  // restart the server. The confirm dialogs land on Cancel because a confirm
  // ASKS something and Cancel is the safe answer; a panel asks nothing, so its
  // dismiss button is not a safe answer, it is undo. Focus lands on the
  // container, which the hook keeps as a real resting place and Tab leaves at
  // once.
  //
  // No `descriptionId` either: the body is a status hero and a key-value list,
  // with no prose that a description should read out. `titleId` replaces the
  // hardcoded `aria-label="Server"` so the announced name and the visible header
  // cannot drift apart.
  const { dialogRef, titleId, isTopmostDialog } = useDialogFocus(true);

  // Esc to close — but only while nothing is layered over the panel.
  //
  // RestartButton and the runtime upgrade row both mount BusyConfirmModal, which
  // portals to `document.body` and listens on `window` exactly as this does. So
  // one Escape ran both handlers: the confirm cancelled AND the panel behind it
  // closed, taking away the thing the user was still deciding about. Measured on
  // the restart path before this guard: `confirmClosed=true panelClosed=true`.
  //
  // The rule stays here rather than in the hook. `isTopmostDialog()` answers a
  // question about layering; what to do about it is dismissal policy, which
  // differs per dialog — TeamModal answers the same question by closing its
  // picker first, and a confirm mid-commit refuses Escape altogether. A hook
  // that owned the rule would have to know all three.
  //
  // The predicate is stable for the life of the instance, so listing it here
  // does not reattach the listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopmostDialog()) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isTopmostDialog]);

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

  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* Desktop backdrop — click to close */}
      <div className="hidden md:block fixed inset-0 bg-page/70 backdrop-blur-sm" onClick={onClose} />

      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={[
          'relative flex h-full w-full flex-col bg-surface',
          'md:absolute md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2',
          'md:h-auto md:max-h-[calc(100dvh-4rem)] md:max-w-xl md:rounded-sm md:border md:border-border-soft md:shadow-deep',
          'transition-[opacity,transform] duration-150 ease-out',
          isReady ? 'opacity-100 scale-100' : 'opacity-0 md:scale-95',
        ].join(' ')}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* ── Panel header ── */}
        {/* Mobile full-screen pages share the home header height (h-14 = 3.5rem,
            which is 52.5px at the app's 15px root, not 56px);
            the desktop modal keeps its compact h-10 chrome. */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border-soft px-3 md:h-10">
          <span id={titleId} className="caps text-text">
            Server
          </span>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            aria-label="Close server panel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto divide-y divide-border-soft">
          {/* Status hero — health + uptime; Restart is the hero action */}
          <div className="flex items-start justify-between gap-4 px-4 py-5 md:px-6">
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
          <div className="px-4 py-5 md:px-6">
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
      </div>
    </div>,
    document.body,
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
