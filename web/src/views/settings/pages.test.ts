import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS_PAGE,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  buildSettingsPath,
  isSettingsPageId,
  isSettingsPath,
  readReturnTo,
  rememberReturnTo,
  settingsPageLabel,
} from './pages';

// The settings URL grammar and the Back bookkeeping, pinned on their own so the
// shell test can concentrate on rendering. Layout branches on `isSettingsPath`
// to drop the agents sidebar and skip the agent reconciler, so a false positive
// here would strip the sidebar from an agent page and a false negative would
// bounce `/settings` to an agent.

describe('settings page grammar', () => {
  it('lists every page exactly once across the two groups, Runtime before Policies', () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(['Runtime', 'Policies']);
    const ids = SETTINGS_GROUPS.flatMap((g) => g.pages.map((p) => p.id));
    expect(ids).toEqual(['server', 'providers', 'token-usage', 'outreach-limits']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(SETTINGS_PAGES.map((p) => p.id)).toEqual(ids);
    expect(DEFAULT_SETTINGS_PAGE).toBe('server');
  });

  it('accepts only the four ids', () => {
    expect(isSettingsPageId('server')).toBe(true);
    expect(isSettingsPageId('outreach-limits')).toBe(true);
    expect(isSettingsPageId('Server')).toBe(false);
    expect(isSettingsPageId('do-not-contact')).toBe(false);
    expect(isSettingsPageId('')).toBe(false);
    expect(isSettingsPageId(undefined)).toBe(false);
  });

  it('builds the list path with no page and the detail path with one', () => {
    expect(buildSettingsPath()).toBe('/settings');
    expect(buildSettingsPath('token-usage')).toBe('/settings/token-usage');
  });

  it('labels pages by their list entry', () => {
    expect(settingsPageLabel('token-usage')).toBe('Token usage');
    expect(settingsPageLabel('outreach-limits')).toBe('Outreach limits');
  });

  it('recognises the settings surface and nothing that merely starts with the word', () => {
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/settings/')).toBe(true);
    expect(isSettingsPath('/settings/providers')).toBe(true);
    expect(isSettingsPath('/settings/not-a-page')).toBe(true); // the view redirects; Layout still steps aside
    expect(isSettingsPath('/settingsx')).toBe(false);
    expect(isSettingsPath('/agents/nora/settings')).toBe(false);
    expect(isSettingsPath('/')).toBe(false);
    expect(isSettingsPath('/kb/team/settings')).toBe(false);
  });
});

describe('settings return-to', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('prefers the navigation state, then the session slot, then the root', () => {
    expect(readReturnTo(null)).toBe('/');
    expect(readReturnTo(undefined)).toBe('/');
    const state = rememberReturnTo('/agents/nora/activity?team=core');
    expect(state).toEqual({ from: '/agents/nora/activity?team=core' });
    expect(readReturnTo(state)).toBe('/agents/nora/activity?team=core');
    // A refresh drops navigation state; the slot still knows.
    expect(readReturnTo(null)).toBe('/agents/nora/activity?team=core');
    // State beats the slot when both exist.
    expect(readReturnTo({ from: '/kb/team' })).toBe('/kb/team');
  });

  it('refuses a return target that is not an in-app path, and never loops back into settings', () => {
    expect(rememberReturnTo('https://evil.example')).toEqual({});
    expect(rememberReturnTo('//evil.example')).toEqual({});
    expect(rememberReturnTo('/settings/server')).toEqual({});
    expect(readReturnTo({ from: 'https://evil.example' })).toBe('/');
    expect(readReturnTo({ from: '/settings/providers' })).toBe('/');
    // None of the refusals wrote the slot.
    expect(sessionStorage.getItem('settings-return-to')).toBeNull();
  });
});
