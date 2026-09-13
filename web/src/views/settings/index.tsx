import { useEffect, useRef } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ChartColumn, ChevronLeft, ChevronRight, Gauge, Server, ShieldOff } from 'lucide-react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useIsMobile } from '@/hooks/use-mobile';
import { useProviderCliStatus } from '@/hooks/useProviderCliStatus';
import { useUpdateAvailable } from '@/hooks/useRuntimeUpgrade';
import ServerPage from './ServerPage';
import ProvidersPage from './ProvidersPage';
import TokenUsagePage from './TokenUsagePage';
import OutreachLimitsPage from './OutreachLimitsPage';
import UpdateAnimaButton from './UpdateAnimaButton';
import {
  DEFAULT_SETTINGS_PAGE,
  SETTINGS_GROUPS,
  buildSettingsPath,
  isSettingsPageId,
  readReturnTo,
  settingsPageLabel,
  type SettingsPageId,
} from './pages';

// ---------------------------------------------------------------------------
// Settings — a standalone full-screen surface at `/settings/:page`.
//
// Desktop: two columns. Left, the settings list (Runtime / Policies) with
// `‹ Back` and the caps SETTINGS title in its header and, only while an update
// is available, the "Update Anima" button in its footer. Right, the page.
// Mobile: two levels. `/settings` is the list; `/settings/:page` is the page
// with `‹ Settings` top-left and the caps title centred.
//
// The agents sidebar is not here on purpose. Everything on this surface is
// instance-scoped (server, providers, spend, outreach policy); showing a
// selected agent next to it would imply the settings belong to that agent.
//
// Back returns to where the user came from. The opener records its pathname
// in navigation state (and a session slot, so a refresh keeps it); with
// nothing recorded, `/` lets the URL reconciler pick an agent.
// ---------------------------------------------------------------------------

const PAGE_ICONS: Record<SettingsPageId, React.ElementType> = {
  server: Server,
  providers: Gauge,
  'token-usage': ChartColumn,
  'outreach-limits': ShieldOff,
};

const PAGE_VIEWS: Record<SettingsPageId, React.ComponentType> = {
  server: ServerPage,
  providers: ProvidersPage,
  'token-usage': TokenUsagePage,
  'outreach-limits': OutreachLimitsPage,
};

export default function SettingsLayout() {
  const { page: pageParam } = useParams<{ page?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const returnTo = readReturnTo(location.state);

  // Unknown page → the list (mobile) or the default page (desktop), by way of
  // the bare path so both branches share one rule.
  if (pageParam !== undefined && !isSettingsPageId(pageParam)) {
    return <Navigate to={buildSettingsPath()} replace state={location.state} />;
  }
  const page: SettingsPageId | null = isSettingsPageId(pageParam) ? pageParam : null;

  // Desktop has no list-only level: `/settings` is the first page.
  if (!isMobile && page === null) {
    return <Navigate to={buildSettingsPath(DEFAULT_SETTINGS_PAGE)} replace state={location.state} />;
  }

  const goBack = () => navigate(returnTo);
  const goPage = (next: SettingsPageId) =>
    navigate(buildSettingsPath(next), { state: location.state });

  if (isMobile) {
    return page === null ? (
      <MobileList onBack={goBack} onSelect={goPage} />
    ) : (
      <MobileDetail page={page} onBack={() => navigate(buildSettingsPath(), { state: location.state })} />
    );
  }

  // `page` is non-null here on desktop (the redirect above handles null).
  const current = page ?? DEFAULT_SETTINGS_PAGE;
  return (
    <div className="flex h-dvh w-screen overflow-hidden bg-surface text-text">
      <nav
        aria-label="Settings"
        className="flex w-[256px] shrink-0 flex-col border-r border-border-soft bg-surface-elevated"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border-soft px-4">
          <BackButton label="Back" onClick={goBack} />
          <span className="caps ml-auto text-text">Settings</span>
        </div>

        <div className="flex-1 overflow-y-auto pb-2">
          {SETTINGS_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="px-4 pb-1 pt-4 font-sans text-[10px] uppercase tracking-[0.14em] text-text-subtle">
                {group.label}
              </div>
              <ul className="space-y-0.5 px-2">
                {group.pages.map((entry) => {
                  const Icon = PAGE_ICONS[entry.id];
                  const active = entry.id === current;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => goPage(entry.id)}
                        aria-current={active ? 'page' : undefined}
                        className={[
                          'flex h-[34px] w-full items-center gap-2.5 rounded-sm px-2 text-left font-sans text-[13px] transition-colors',
                          active
                            ? 'bg-surface text-text ring-1 ring-border-soft'
                            : 'text-text-muted hover:bg-surface-hover hover:text-text',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                        ].join(' ')}
                      >
                        <Icon aria-hidden className="h-[13px] w-[13px] shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                        <PagePill page={entry.id} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <UpdateAnimaButton />
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="max-w-[680px] px-10 pb-12 pt-9">
          <PageBody page={current} />
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail body — shared by desktop and the mobile detail level.
// ---------------------------------------------------------------------------

function PageBody({ page, hideTitle = false }: { page: SettingsPageId; hideTitle?: boolean }) {
  const View = PAGE_VIEWS[page];
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Switching pages is a navigation, so focus follows: the new page's title
  // takes it, which also announces the page to a screen reader. Not on the
  // mobile detail level, where the title lives in the top bar.
  useEffect(() => {
    if (!hideTitle) titleRef.current?.focus();
  }, [page, hideTitle]);

  return (
    // Keyed so a crash in one page never traps the shell: navigating to another
    // page remounts the boundary, and Back stays reachable either way.
    <ErrorBoundary key={page}>
      {!hideTitle && (
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="display mb-1.5 text-[24px] font-semibold tracking-[-0.01em] text-text focus-visible:outline-none"
        >
          {settingsPageLabel(page)}
        </h1>
      )}
      <View />
    </ErrorBoundary>
  );
}

/** "Update" beside Providers when a provider CLI update is waiting; beside
 *  Server only on mobile, where the list has no footer button to say so. */
function PagePill({ page, mobile = false }: { page: SettingsPageId; mobile?: boolean }) {
  const { data: providerCliStatus } = useProviderCliStatus();
  const updateAvailable = useUpdateAvailable();
  const providerUpdate = providerCliStatus?.providers.some((row) => row.updateAvailable) ?? false;
  const show = (page === 'providers' && providerUpdate) || (mobile && page === 'server' && updateAvailable);
  if (!show) return null;
  return (
    <span className="shrink-0 rounded-[2px] border border-accent px-1.5 py-px font-sans text-[10px] tracking-[0.04em] text-accent">
      Update
    </span>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-ml-2 flex min-h-[44px] items-center gap-1 rounded-sm pl-1 pr-2 font-sans text-[12px] text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent md:min-h-8"
    >
      <ChevronLeft aria-hidden className="h-4 w-4" />
      <span>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mobile — two levels.
// ---------------------------------------------------------------------------

function MobileBar({
  title,
  backLabel,
  onBack,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <div
      className="sticky top-0 z-10 grid h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border-soft bg-surface px-3 pt-[env(safe-area-inset-top)]"
    >
      <div className="flex justify-start">
        <BackButton label={backLabel} onClick={onBack} />
      </div>
      <span className="caps text-text">{title}</span>
      <span aria-hidden />
    </div>
  );
}

function MobileList({
  onBack,
  onSelect,
}: {
  onBack: () => void;
  onSelect: (page: SettingsPageId) => void;
}) {
  return (
    <div className="flex h-dvh flex-col bg-surface text-text">
      <MobileBar title="Settings" backLabel="Back" onBack={onBack} />
      <nav aria-label="Settings" className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {SETTINGS_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-4 pb-1.5 pt-[18px] font-sans text-[10px] uppercase tracking-[0.14em] text-text-subtle">
              {group.label}
            </div>
            <ul className="divide-y divide-border-soft border-y border-border-soft">
              {group.pages.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(entry.id)}
                    className="flex min-h-12 w-full items-center gap-3 px-4 text-left font-sans text-[14px] text-text hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
                  >
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    <PagePill page={entry.id} mobile />
                    <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-text-subtle" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}

function MobileDetail({ page, onBack }: { page: SettingsPageId; onBack: () => void }) {
  return (
    <div className="flex h-dvh flex-col bg-surface text-text">
      <MobileBar title={settingsPageLabel(page)} backLabel="Settings" onBack={onBack} />
      <main className="flex-1 overflow-y-auto px-4 pb-[calc(2rem+env(safe-area-inset-bottom))] pt-5">
        <PageBody page={page} hideTitle />
      </main>
    </div>
  );
}
