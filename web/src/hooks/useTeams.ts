import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchTeams } from '@/api/teams';
import { queryKeys } from '@/lib/query-keys';
import { DEFAULT_TEAM_ID } from '@shared/server-settings';
import type { TeamConfig } from '@shared/server-settings';

// The effective team registry. Always resolves to at least the default team, so
// consumers can treat `teams[0]` as a safe fallback working context.
export function useTeams(): TeamConfig[] {
  const { data: teams = [] } = useQuery({
    queryKey: queryKeys.teams(),
    queryFn: fetchTeams,
    staleTime: 30_000,
  });
  return teams;
}

const CURRENT_TEAM_KEY = 'anima.currentTeamId';

function readStoredTeam(): string | null {
  try {
    return localStorage.getItem(CURRENT_TEAM_KEY);
  } catch {
    return null;
  }
}

// Working context = which team the switcher points at (main-panel focus + where
// "+ New agent" lands). Persisted client-side, mirroring how agent selection is
// already a client-only concern. It is NOT a visibility filter — every team's
// agents stay visible regardless of the current context.
export function useCurrentTeam(teams: TeamConfig[]): {
  currentTeamId: string;
  currentTeam: TeamConfig | undefined;
  setCurrentTeamId: (id: string) => void;
} {
  const [stored, setStored] = useState<string | null>(() => readStoredTeam());

  const valid = stored !== null && teams.some((t) => t.id === stored);
  const currentTeamId = valid ? (stored as string) : (teams[0]?.id ?? DEFAULT_TEAM_ID);
  const currentTeam = teams.find((t) => t.id === currentTeamId);

  const setCurrentTeamId = useCallback((id: string) => {
    setStored(id);
    try {
      localStorage.setItem(CURRENT_TEAM_KEY, id);
    } catch {
      // Storage unavailable (private mode / quota) — context falls back to
      // default on reload, which is acceptable for a soft grouping.
    }
  }, []);

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
