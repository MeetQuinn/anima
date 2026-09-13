// Settings URL grammar — `/settings` and `/settings/<page>`.
//
// Pure helpers, no React. Layout uses `isSettingsPath` to hand the whole
// viewport to the settings shell (no agents sidebar, no URL reconciler), and
// the shell uses `SETTINGS_PAGES` to draw its list and validate `:page`.

export const SETTINGS_PAGE_IDS = ['server', 'providers', 'token-usage', 'outreach-limits'] as const;
export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number];

export const DEFAULT_SETTINGS_PAGE: SettingsPageId = 'server';
export const SETTINGS_PREFIX = 'settings';

export interface SettingsPageMeta {
  id: SettingsPageId;
  label: string;
}

export interface SettingsGroup {
  label: string;
  pages: SettingsPageMeta[];
}

/**
 * Two groups. Runtime is what the instance IS (status, providers, spend);
 * Policies is what its agents may DO. Rules an operator edits deserve their own
 * heading rather than hiding under a status panel.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    label: 'Runtime',
    pages: [
      { id: 'server', label: 'Server' },
      { id: 'providers', label: 'Providers' },
      { id: 'token-usage', label: 'Token usage' },
    ],
  },
  {
    label: 'Policies',
    pages: [{ id: 'outreach-limits', label: 'Outreach limits' }],
  },
];

export const SETTINGS_PAGES: readonly SettingsPageMeta[] = SETTINGS_GROUPS.flatMap((g) => g.pages);

export function isSettingsPageId(value: string | undefined): value is SettingsPageId {
  return value !== undefined && (SETTINGS_PAGE_IDS as readonly string[]).includes(value);
}

export function settingsPageLabel(id: SettingsPageId): string {
  return SETTINGS_PAGES.find((page) => page.id === id)?.label ?? id;
}

export function buildSettingsPath(page?: SettingsPageId): string {
  return page ? `/${SETTINGS_PREFIX}/${page}` : `/${SETTINGS_PREFIX}`;
}

/** True for `/settings` and anything under it. */
export function isSettingsPath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  return segments[0] === SETTINGS_PREFIX;
}

// ---------------------------------------------------------------------------
// Return-to — where `‹ Back` on the settings surface goes.
//
// The opener records its own path (path + query) in navigation state and in a
// session slot; state wins for the hop, the slot survives a refresh or a deep
// link opened in the same tab. With nothing recorded, `/` lets the agent URL
// reconciler pick the default agent.
// ---------------------------------------------------------------------------

const RETURN_TO_KEY = 'settings-return-to';

export interface SettingsReturnState {
  from?: string;
}

/** Only in-app paths; anything else (external URL, another settings path) is ignored. */
function usableReturnTo(from: unknown): from is string {
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !isSettingsPath(from);
}

export function readReturnTo(state: unknown): string {
  const fromState = (state as SettingsReturnState | null)?.from;
  if (usableReturnTo(fromState)) return fromState;
  try {
    const stored = sessionStorage.getItem(RETURN_TO_KEY);
    return usableReturnTo(stored) ? stored : '/';
  } catch {
    return '/';
  }
}

/** Openers call this and pass the result as navigation `state`. */
export function rememberReturnTo(from: string): SettingsReturnState {
  if (!usableReturnTo(from)) return {};
  try {
    sessionStorage.setItem(RETURN_TO_KEY, from);
  } catch {
    /* storage unavailable — state still carries it for this hop */
  }
  return { from };
}
