import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamConfig } from '@shared/server-settings';
import { useCurrentTeam } from './useTeams';

const CURRENT_TEAM_KEY = 'anima.currentTeamId';

const TEAMS: TeamConfig[] = [
  { id: 'alpha', name: 'Alpha', home: '~/alpha' },
  { id: 'beta', name: 'Beta', home: '~/beta' },
];

// jsdom's built-in storage support is uneven (sessionStorage present, localStorage
// often not), so we install deterministic in-memory Storage stubs for BOTH. This
// also makes the cross-tab assertion meaningful: we can seed localStorage and prove
// the hook never reads it.
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  };
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', makeStorage());
  vi.stubGlobal('localStorage', makeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapperAt(url: string) {
  return ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [url] }, children);
}

function render(url: string) {
  return renderHook(() => useCurrentTeam(TEAMS), { wrapper: wrapperAt(url) });
}

describe('useCurrentTeam persistence', () => {
  it('persists the resolved team to sessionStorage, never localStorage', () => {
    render('/?team=beta');

    // The "remember my team" seed must be tab-local (sessionStorage), so two
    // tabs on different teams cannot clobber each other's fallback.
    expect(sessionStorage.getItem(CURRENT_TEAM_KEY)).toBe('beta');
    expect(localStorage.getItem(CURRENT_TEAM_KEY)).toBeNull();
  });

  it('garbage-collects the stale localStorage key on write', () => {
    // A pre-upgrade build left the origin-shared key behind.
    localStorage.setItem(CURRENT_TEAM_KEY, 'beta');

    render('/?team=alpha');

    // The write path (sync effect) should have removed it, so no stale
    // origin-shared team survives the upgrade.
    expect(localStorage.getItem(CURRENT_TEAM_KEY)).toBeNull();
    expect(sessionStorage.getItem(CURRENT_TEAM_KEY)).toBe('alpha');
  });

  it('ignores a localStorage seed left by another tab (cross-tab jump regression)', () => {
    // Simulate the old shared-localStorage world: another tab wrote its team.
    localStorage.setItem(CURRENT_TEAM_KEY, 'beta');

    // This tab has no ?team= param and an empty sessionStorage, so it must fall
    // back to teams[0] — NOT the other tab's localStorage value.
    const { result } = render('/');

    expect(result.current.currentTeamId).toBe('alpha');
  });

  it('seeds the working context from this tab-s own sessionStorage', () => {
    sessionStorage.setItem(CURRENT_TEAM_KEY, 'beta');

    const { result } = render('/');

    expect(result.current.currentTeamId).toBe('beta');
  });

  it('lets a valid ?team= param win over the sessionStorage seed', () => {
    sessionStorage.setItem(CURRENT_TEAM_KEY, 'alpha');

    const { result } = render('/?team=beta');

    expect(result.current.currentTeamId).toBe('beta');
  });

  it('falls back to the first team when the seed no longer resolves', () => {
    sessionStorage.setItem(CURRENT_TEAM_KEY, 'ghost');

    const { result } = render('/');

    expect(result.current.currentTeamId).toBe('alpha');
  });
});
