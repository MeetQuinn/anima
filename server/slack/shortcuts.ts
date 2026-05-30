export const SLACK_SHORTCUT_COMMANDS_SCOPE = 'commands';

export const SLACK_SHORTCUTS = [
  {
    callback_id: 'anima.home',
    description: 'Open this agent\'s Anima home.',
    name: 'Home',
    type: 'global',
  },
  {
    callback_id: 'anima.hand_to_agent',
    description: 'Hand this message to the agent as a task.',
    name: 'Hand to agent',
    type: 'message',
  },
] as const;

export type SlackShortcutDefinition = typeof SLACK_SHORTCUTS[number];
const CURRENT_SLACK_SHORTCUT_CALLBACK_IDS = new Set<string>(
  SLACK_SHORTCUTS.map((shortcut) => shortcut.callback_id),
);

export function slackShortcutManifestUpdateYaml(): string {
  return [
    'oauth_config:',
    '  scopes:',
    '    bot:',
    `      - ${SLACK_SHORTCUT_COMMANDS_SCOPE}`,
    'features:',
    '  shortcuts:',
    ...SLACK_SHORTCUTS.flatMap((shortcut) => [
      `    - name: ${yamlString(shortcut.name)}`,
      `      type: ${shortcut.type}`,
      `      callback_id: ${shortcut.callback_id}`,
      `      description: ${yamlString(shortcut.description)}`,
    ]),
  ].join('\n');
}

export interface SlackShortcutManifestStatus {
  commandsScope: boolean;
  missingShortcutCallbackIds: string[];
  ready: boolean;
}

export interface SlackShortcutManifestUpdate {
  manifest: Record<string, unknown>;
  status: SlackShortcutManifestStatus;
  updated: boolean;
}

export function inspectSlackShortcutManifest(manifest: unknown): SlackShortcutManifestStatus {
  const root = record(manifest) ?? {};
  const botScopes = botScopeList(root);
  const existing = shortcutList(root);
  const shortcutByCallbackId = new Map(
    existing
      .map((shortcut) => record(shortcut))
      .filter(Boolean)
      .map((shortcut) => [stringField(shortcut, 'callback_id'), shortcut])
      .filter(([callbackId]) => Boolean(callbackId)) as Array<[string, Record<string, unknown>]>,
  );
  const missingShortcutCallbackIds = SLACK_SHORTCUTS
    .filter((shortcut) => {
      const existingShortcut = shortcutByCallbackId.get(shortcut.callback_id);
      return !existingShortcut || stringField(existingShortcut, 'type') !== shortcut.type;
    })
    .map((shortcut) => shortcut.callback_id);
  const commandsScope = botScopes.includes(SLACK_SHORTCUT_COMMANDS_SCOPE);
  return {
    commandsScope,
    missingShortcutCallbackIds,
    ready: commandsScope && missingShortcutCallbackIds.length === 0,
  };
}

export function ensureSlackShortcutManifest(manifest: unknown): SlackShortcutManifestUpdate {
  const next = cloneManifest(manifest);
  const before = inspectSlackShortcutManifest(next);

  const oauthConfig = ensureRecord(next, 'oauth_config');
  const scopes = ensureRecord(oauthConfig, 'scopes');
  const botScopes = ensureStringArray(scopes, 'bot');
  if (!botScopes.includes(SLACK_SHORTCUT_COMMANDS_SCOPE)) {
    botScopes.push(SLACK_SHORTCUT_COMMANDS_SCOPE);
    botScopes.sort();
  }

  const features = ensureRecord(next, 'features');
  const shortcuts = ensureArray(features, 'shortcuts');
  for (let index = shortcuts.length - 1; index >= 0; index -= 1) {
    const callbackId = stringField(record(shortcuts[index]), 'callback_id');
    if (callbackId?.startsWith('anima.') && !CURRENT_SLACK_SHORTCUT_CALLBACK_IDS.has(callbackId)) {
      shortcuts.splice(index, 1);
    }
  }
  const byCallbackId = new Map<string, number>();
  shortcuts.forEach((shortcut, index) => {
    const callbackId = stringField(record(shortcut), 'callback_id');
    if (callbackId) byCallbackId.set(callbackId, index);
  });
  for (const shortcut of SLACK_SHORTCUTS) {
    const existingIndex = byCallbackId.get(shortcut.callback_id);
    const value = { ...shortcut };
    if (existingIndex === undefined) {
      shortcuts.push(value);
    } else {
      shortcuts[existingIndex] = { ...record(shortcuts[existingIndex]), ...value };
    }
  }

  const status = inspectSlackShortcutManifest(next);
  return {
    manifest: next,
    status,
    updated: !before.ready || JSON.stringify(next) !== JSON.stringify(cloneManifest(manifest)),
  };
}

export function parseOauthScopesHeader(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export function hasCommandsScope(scopes: readonly string[]): boolean {
  return scopes.includes(SLACK_SHORTCUT_COMMANDS_SCOPE);
}

function cloneManifest(manifest: unknown): Record<string, unknown> {
  if (!isRecord(manifest)) return {};
  return JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
}

function botScopeList(manifest: Record<string, unknown>): string[] {
  const oauthConfig = record(manifest['oauth_config']);
  const scopes = record(oauthConfig?.['scopes']);
  return stringArray(scopes?.['bot']);
}

function shortcutList(manifest: Record<string, unknown>): unknown[] {
  const features = record(manifest['features']);
  const shortcuts = features?.['shortcuts'];
  return Array.isArray(shortcuts) ? shortcuts : [];
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = record(parent[key]);
  if (existing) return existing;
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function ensureStringArray(parent: Record<string, unknown>, key: string): string[] {
  if (Array.isArray(parent[key])) {
    const values = stringArray(parent[key]);
    parent[key] = values;
    return values;
  }
  const values: string[] = [];
  parent[key] = values;
  return values;
}

function ensureArray(parent: Record<string, unknown>, key: string): unknown[] {
  if (Array.isArray(parent[key])) return parent[key];
  const values: unknown[] = [];
  parent[key] = values;
  return values;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' ? field : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
