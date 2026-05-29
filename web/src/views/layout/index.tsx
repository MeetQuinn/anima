import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, Outlet, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { fetchAgents, fetchAgentStatuses } from '@/api/agents';
import { queryKeys } from '@/lib/query-keys';
import {
  parseLocation,
  parseKbPath,
  reconcileLocation,
  buildPath,
} from '@/lib/url-state';
import Sidebar from './Sidebar';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { RestartEchoToast } from '@/components/restart-shared';
import MobileTopBar from './MobileTopBar';
import MobileBottomNav from './MobileBottomNav';
import MobileNavScreen from './MobileNavScreen';
import { useIsMobile } from '@/hooks/use-mobile';

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem('sidebar-collapsed') === 'true';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Agent URL reconciler
//
// Watches agents / agentStatuses changes and replaceState-corrects the URL
// when it's in an invalid or incomplete state (no agent selected, unknown
// agentId, no tab, etc).
// ---------------------------------------------------------------------------

function AgentReconciler({ disabled }: { disabled?: boolean }) {
  const { data: agents } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const { data: agentStatuses } = useQuery({ queryKey: queryKeys.agentStatuses(), queryFn: fetchAgentStatuses });
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (disabled) return;
    if (!agents || !agentStatuses) return;
    // Skip reconciliation on kb paths — they don't use the agent grammar.
    if (parseKbPath(location.pathname)) return;
    const parsed = parseLocation(location.pathname);
    const snapshot = {
      agents,
      agentStatuses,
      selectedAgentId: agents[0]?.id,
    };
    const target = reconcileLocation(snapshot, parsed);
    if (target) navigate(buildPath(target), { replace: true });
  }, [disabled, agents, agentStatuses, location.pathname, navigate]);

  return null;
}

// ---------------------------------------------------------------------------
// Root layout
// ---------------------------------------------------------------------------

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const isMobile = useIsMobile();

  // Top-level Kb surface lives outside the agent/tab grammar.
  const kbLocation = parseKbPath(location.pathname);

  // Derive agentId from URL.
  const { agentId } = parseLocation(location.pathname);

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      localStorage.setItem('sidebar-collapsed', String(next));
    } catch {}
  };

  // Navigate to /agents/:id (no tab) — AgentReconciler fills the right default
  // tab: 'activity' for connected agents, 'profile' for not-yet-connected ones.
  const setAgentId = useCallback(
    (id: string | null) => {
      navigate(id ? `/agents/${id}` : '/');
    },
    [navigate],
  );

  // Track the last explicitly selected agent so MobileNavScreen (Screen 1) can
  // show a selected-state highlight after navigating back from Screen 2.
  // Screen 1 only renders when agentId === null, so we persist the last non-null value.
  const lastSelectedAgentRef = useRef<string | null>(null);
  if (agentId) lastSelectedAgentRef.current = agentId;

  // First-run: when there are no agents (and the list has loaded), redirect to
  // the dedicated /onboarding route. Must come after all hooks.
  const { data: agents } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  if (agents !== undefined && agents.length === 0) {
    return <Navigate to="/onboarding" replace />;
  }

  // On mobile Screen 1 (no agent selected, not in kb), suppress
  // AgentReconciler's auto-select so the user stays on the nav list.
  const reconcilerDisabled = isMobile && !agentId && !kbLocation;

  // Mobile Screen 1: full-screen nav list — completely replaces the normal layout.
  const showMobileNav = isMobile && !agentId && !kbLocation;

  return (
    <>
      {/* App-level: honest post-restart echo, survives the restart's page reload
          (which closes the Server panel). Portals to body. */}
      <RestartEchoToast />

      {!kbLocation && <AgentReconciler disabled={reconcilerDisabled} />}

      {showMobileNav ? (
        /* ── Mobile Screen 1: nav list ── */
        <MobileNavScreen
          onSelectAgent={(id) => setAgentId(id)}
          lastSelectedId={lastSelectedAgentRef.current}
        />
      ) : (
        /* ── Desktop + Mobile Screen 2: agent detail (+ kb) ── */
        <div className="flex h-dvh w-screen overflow-hidden bg-page text-text">
          <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
            {/* Fixed mobile top bar (Screen 2 only; returns null when no agent) */}
            <MobileTopBar />
            {/* Top spacer on mobile to compensate for fixed top bar.
                Only needed on Screen 2 (agentId set); kb mode
                and Screen 1 don't have a fixed top bar. */}
            {agentId && <div className="h-14 shrink-0 md:hidden" />}
            <ErrorBoundary key={location.pathname}>
              <Outlet />
            </ErrorBoundary>
            {/* Bottom spacer on mobile to compensate for fixed bottom nav.
                Only needed on Screen 2 (agentId set). */}
            {agentId && (
              <div className="h-[calc(3.5rem+env(safe-area-inset-bottom))] shrink-0 md:hidden" />
            )}
            <MobileBottomNav />
          </main>
        </div>
      )}
    </>
  );
}
