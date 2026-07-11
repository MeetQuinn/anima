import { useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchTeams } from '@/api/teams';
import { queryKeys } from '@/lib/query-keys';
import { DEFAULT_TEAM_ID } from '@shared/server-settings';
import type { AgentTeamWarning, TeamConfig } from '@shared/server-settings';

const TEAMS_QUERY = {
  queryKey: queryKeys.teams(),
  queryFn: fetchTeams,
  staleTime: 30_000,
} as const;

// The effective team registry. Always resolves to at least the default team, so
// consumers can treat `teams[0]` as a safe fallback working context.
export function useTeams(): TeamConfig[] {
  const { data } = useQuery({ ...TEAMS_QUERY, select: (r) => r.teams });
  return data ?? [];
}

// Repairable team-reference warnings (agents whose teamId no longer resolves). Shares the same
// query as useTeams, so no extra fetch. Empty in a healthy install.
export function useTeamWarnings(): AgentTeamWarning[] {
  const { data } = useQuery({ ...TEAMS_QUERY, select: (r) => r.warnings });
  return data ?? [];
}

const CURRENT_TEAM_KEY = 'anima.currentTeamId';
// URL query key that carries the working-context team. Exported so navigations
// that clear the main panel (e.g. a team switch) can preserve it in the same
// hop, avoiding a param-drop + re-sync race with AgentReconciler.
export const TEAM_PARAM = 'team';

// The team fallback is persisted in sessionStorage, NOT localStorage, so it is
// scoped to a single tab. localStorage is shared across every tab of the same
// origin: with two tabs open on different teams, each tab's sync effect below
// writes its own team into one shared key, so the value ping-pongs. Then any
// navigation that drops `?team=` (clicking an agent/KB/home) makes a tab fall
// back to `paramTeam ?? stored` and read whatever the OTHER tab last wrote —
// silently jumping to the other team. sessionStorage is per browsing context,
// so each tab only ever reads back its own last team. The `?team=` URL param
// stays the shareable source of truth (it always wins over the fallback); only
// the "remember my team" seed becomes tab-local. Cost: a brand-new tab with no
// param starts on the default team instead of inheriting another tab's — the
// correct tradeoff for a per-tab working context.
function readStoredTeam(): string | null {
  try {
    return sessionStorage.getItem(CURRENT_TEAM_KEY);
  } catch {
    return null;
  }
}

function writeStoredTeam(id: string): void {
  try {
    sessionStorage.setItem(CURRENT_TEAM_KEY, id);
    // Garbage-collect the pre-sessionStorage key. Older builds wrote this same
    // key to localStorage, where it lingers unread forever (and was the shared
    // value that caused cross-tab bleed). Drop it so no stale origin-shared team
    // survives the upgrade. Best-effort: a failure here is harmless.
    localStorage.removeItem(CURRENT_TEAM_KEY);
  } catch {
    // Storage unavailable (private mode / quota): the URL param still carries
    // the team for this tab's session, which is enough.
  }
}

// Working context = which team the sidebar is scoped to (its agents + KBs, and
// where "+ add agent" / "+ add KB" land). Source of truth is the `?team=` URL
// query param, so the current team is shareable/bookmarkable and every consumer
// of this hook reads the same value (no per-instance desync). sessionStorage is
// a per-tab persistence fallback: it seeds the resolved team when the URL has no
// param (fresh load / a navigation that dropped it), and a sync effect writes
// the param back so the URL stays canonical. See readStoredTeam for why this is
// sessionStorage (tab-local) and not localStorage (shared, cross-tab bleed).
//
// Query param over a path segment on purpose: the team is a cross-cutting view
// lens layered on any route, not a container in the resource hierarchy (an agent
// belongs to exactly one team, so `/team/x/agents/y` could contradict itself).
export function useCurrentTeam(teams: TeamConfig[]): {
  currentTeamId: string;
  currentTeam: TeamConfig | undefined;
  setCurrentTeamId: (id: string) => void;
} {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const paramTeam = searchParams.get(TEAM_PARAM);

  // Resolve precedence: valid URL param → valid stored team → first/default.
  const stored = readStoredTeam();
  const candidate = paramTeam ?? stored;
  const valid = candidate !== null && teams.some((t) => t.id === candidate);
  const currentTeamId = valid ? (candidate as string) : (teams[0]?.id ?? DEFAULT_TEAM_ID);
  const currentTeam = teams.find((t) => t.id === currentTeamId);

  const writeParam = useCallback(
    (id: string) => {
      const next = new URLSearchParams(window.location.search);
      next.set(TEAM_PARAM, id);
      // Not setSearchParams: it drops location.hash. This runs at boot to
      // canonicalize `?team=`, and on a fresh deep link (/kb/...#heading)
      // teams resolve before the file body, so the incoming hash was being
      // destroyed before the viewer could land it (#493 gate blocker).
      // window.location is read at call time - the hash may have been written
      // by history.replaceState (scroll sync), which the router never sees.
      navigate(
        { search: next.toString(), hash: window.location.hash },
        { replace: true },
      );
    },
    [navigate],
  );

  // Keep the URL canonical once teams have loaded, and keep localStorage tracking the
  // RESOLVED team. Two jobs:
  //  1. Reflect the resolved team into `?team=` when missing/stale (e.g. after a
  //     navigate() that dropped the query). No-op when it already matches.
  //  2. Persist currentTeamId to localStorage so `stored` always equals the resolved
  //     team. Without this, an internal navigation that transiently drops the param
  //     would fall back to a STALE localStorage value (`paramTeam ?? stored`), flipping
  //     away from the intended team — which would break shared links (?team=X opened in
  //     a browser whose last team was Y).
  useEffect(() => {
    if (teams.length === 0) return;
    writeStoredTeam(currentTeamId);
    if (paramTeam !== currentTeamId) writeParam(currentTeamId);
  }, [teams.length, paramTeam, currentTeamId, writeParam]);

  const setCurrentTeamId = useCallback(
    (id: string) => {
      writeStoredTeam(id);
      writeParam(id);
    },
    [writeParam],
  );

  return { currentTeamId, currentTeam, setCurrentTeamId };
}
