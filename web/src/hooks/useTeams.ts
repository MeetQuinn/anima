import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
const TEAM_PARAM = 'team';

function readStoredTeam(): string | null {
  try {
    return localStorage.getItem(CURRENT_TEAM_KEY);
  } catch {
    return null;
  }
}

// Working context = which team the sidebar is scoped to (its agents + KBs, and
// where "+ add agent" / "+ add KB" land). Source of truth is the `?team=` URL
// query param, so the current team is shareable/bookmarkable and every consumer
// of this hook reads the same value (no per-instance desync). localStorage is a
// persistence fallback: it seeds the resolved team when the URL has no param
// (fresh load / a navigation that dropped it), and a sync effect writes the
// param back so the URL stays canonical.
//
// Query param over a path segment on purpose: the team is a cross-cutting view
// lens layered on any route, not a container in the resource hierarchy (an agent
// belongs to exactly one team, so `/team/x/agents/y` could contradict itself).
export function useCurrentTeam(teams: TeamConfig[]): {
  currentTeamId: string;
  currentTeam: TeamConfig | undefined;
  setCurrentTeamId: (id: string) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramTeam = searchParams.get(TEAM_PARAM);

  // Resolve precedence: valid URL param → valid stored team → first/default.
  const stored = readStoredTeam();
  const candidate = paramTeam ?? stored;
  const valid = candidate !== null && teams.some((t) => t.id === candidate);
  const currentTeamId = valid ? (candidate as string) : (teams[0]?.id ?? DEFAULT_TEAM_ID);
  const currentTeam = teams.find((t) => t.id === currentTeamId);

  const writeParam = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(TEAM_PARAM, id);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Keep the URL canonical once teams have loaded: reflect the resolved team into
  // `?team=` when it is missing or stale (e.g. after a navigate() that dropped
  // the query). No-op when it already matches, so this does not loop.
  useEffect(() => {
    if (teams.length === 0) return;
    if (paramTeam === currentTeamId) return;
    writeParam(currentTeamId);
  }, [teams.length, paramTeam, currentTeamId, writeParam]);

  const setCurrentTeamId = useCallback(
    (id: string) => {
      try {
        localStorage.setItem(CURRENT_TEAM_KEY, id);
      } catch {
        // Storage unavailable (private mode / quota) — the URL param still holds
        // the choice for this session, which is enough.
      }
      writeParam(id);
    },
    [writeParam],
  );

  return { currentTeamId, currentTeam, setCurrentTeamId };
}

const COLLAPSED_TEAMS_KEY = 'anima.collapsedTeamIds';

function readCollapsedTeams(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_TEAMS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

// Which team groups are folded, persisted client-side. Default is expanded (an
// empty set): fold-default is deliberately left open to tune after it is
// clickable, per the cut-1 acceptance.
export function useCollapsedTeams(): {
  isCollapsed: (teamId: string) => boolean;
  toggle: (teamId: string) => void;
} {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsedTeams());

  const isCollapsed = useCallback((teamId: string) => collapsed.has(teamId), [collapsed]);

  const toggle = useCallback((teamId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId);
      else next.add(teamId);
      try {
        localStorage.setItem(COLLAPSED_TEAMS_KEY, JSON.stringify([...next]));
      } catch {
        // best-effort persistence
      }
      return next;
    });
  }, []);

  return { isCollapsed, toggle };
}
