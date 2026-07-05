import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, Outlet, Navigate } from 'react-router-dom';

import { useAgents, useAgentStatuses } from '@/hooks/useAgentDirectory';
import {
  parseLocation,
  parseKbPath,
  reconcileLocation,
  buildPath,
  DEFAULT_TAB,
} from '@/lib/url-state';
import type { UrlLocation } from '@/lib/url-state';
import { agentHasConnectedTransport } from '@shared/agent-transports';
import { effectiveTeamId } from '@/lib/teams';
import { useTeams, useCurrentTeam } from '@/hooks/useTeams';
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
  const { data: agents } = useAgents();
  const { data: agentStatuses } = useAgentStatuses();
  const location = useLocation();
  const navigate = useNavigate();
  const teams = useTeams();
  const { currentTeamId } = useCurrentTeam(teams);

  useEffect(() => {
    if (disabled) return;
    if (!agents || !agentStatuses) return;
    // Wait for the team registry before ANY reconcile navigation. Until it loads,
    // `useCurrentTeam` cannot validate a `?team=X` deep link — it degrades X to the
    // default — so navigating now would resolve against the wrong team AND drop the
    // param before it ever sticks (useTeams always yields >= 1 team once loaded, so
    // length 0 reliably means "not loaded yet"). The invariant: `/?team=X` must not
    // drive a navigation before X has been validated or explicitly degraded.
    if (teams.length === 0) return;
    // Skip reconciliation on kb paths — they don't use the agent grammar.
    if (parseKbPath(location.pathname)) return;
    const parsed = parseLocation(location.pathname);

    // Preserve the current query (notably `?team=`) across every reconcile
    // navigation, so a team-scoped auto-pick or tab-fill never strips the param.
    const navTo = (loc: UrlLocation) =>
      navigate({ pathname: buildPath(loc), search: location.search }, { replace: true });

    // No agent in the URL: auto-pick, but scoped to the current team so the main
    // panel follows the sidebar. When the current team has no agents we leave the
    // URL at `/` (blank main panel) instead of bouncing to another team's agent —
    // this is what makes a team switch "clear" the panel for an empty team.
    if (!parsed.agentId) {
      const teamIds = new Set(teams.map((t) => t.id));
      const teamAgents = agents.filter((a) => effectiveTeamId(a, teamIds) === currentTeamId);
      if (teamAgents.length === 0) return; // nothing to select — stay blank
      const teamAgentIds = new Set(teamAgents.map((a) => a.id));
      const active = agentStatuses.find(
        (s) => teamAgentIds.has(s.agentId) && (s.currentItemId || s.queueDepth > 0),
      );
      const pickId = active?.agentId ?? teamAgents[0].id;
      const picked = teamAgents.find((a) => a.id === pickId);
      const tab = picked && agentHasConnectedTransport(picked) ? DEFAULT_TAB : 'profile';
      navTo({ agentId: pickId, tab });
      return;
    }

    // A specific agent is in the URL: keep the standard validity + default-tab
    // path against the full agent list, so a valid agent still renders (and gets
    // its tab filled) even when reached via a cross-team deep link.
    const target = reconcileLocation(
      { agents, agentStatuses, selectedAgentId: agents[0]?.id },
      parsed,
    );
    if (target) navTo(target);
  }, [disabled, agents, agentStatuses, location.pathname, location.search, navigate, teams, currentTeamId]);

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
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);

  // First-run: when there are no agents (and the list has loaded), redirect to
  // the dedicated /onboarding route. Must come after all hooks.
  const { data: agents } = useAgents();
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
          onSelectAgent={(id) => {
            setAgentId(id);
            setLastSelectedId(id);
          }}
          lastSelectedId={lastSelectedId}
        />
      ) : (
        /* ── Desktop + Mobile Screen 2: agent detail (+ kb) ── */
        /* The dark `bg-page` spine is the desktop sidebar backdrop. On mobile the
           sidebar is hidden and `<main>` (paper) is the only visible surface, so the
           dark shell has no purpose there — and during the iOS / in-app-webview
           toolbar transition it briefly peeks through the bottom dvh gap as a black
           band (same family as the #128 html/body fix, second source). Keep it paper
           on mobile, dark spine on desktop. */
        <div className="flex h-dvh w-screen overflow-hidden bg-surface text-text md:bg-page">
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
