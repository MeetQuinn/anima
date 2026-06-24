import { delimiter, dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * ANIMA_* variables that describe one in-flight runtime item must not leak
 * into daemonized service commands. Long-running services inherit the target
 * home, not the caller's item context.
 */
export const RUNTIME_ENV_KEYS = [
  'ANIMA_AGENT_ID',
  'ANIMA_CHANNEL',
  'ANIMA_CHANNEL_ID',
  'ANIMA_CHANNEL_NAME',
  'ANIMA_HOME',
  'ANIMA_INSTRUCTIONS_PATH',
  'ANIMA_RUNTIME_HOME',
  'ANIMA_MESSAGE_TS',
  'ANIMA_REMINDER_ID',
  'ANIMA_RESTART_RESULT_FILE',
  'ANIMA_INBOX_ITEM_ID',
  'ANIMA_SESSION_KEY',
  'ANIMA_SLACK_BOT_TOKEN',
  'ANIMA_SURFACE_KIND',
  'ANIMA_THREAD',
  'ANIMA_THREAD_TS',
  'ANIMA_WORKSPACE_PATH',
  'FEISHU_API_BASE_URL',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_BOT_OPEN_ID',
  'FEISHU_TENANT_ACCESS_TOKEN',
  'FEISHU_TENANT_ACCESS_TOKEN_EXPIRES_AT',
  'SLACK_BOT_TOKEN',
] as const;

export function cleanServiceEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of RUNTIME_ENV_KEYS) delete env[key];
  return env;
}

export interface ServiceEnvironmentOptions {
  animaHome: string;
  baseEnv?: NodeJS.ProcessEnv;
  homeDir?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
}

/**
 * Service managers do not load the user's shell rc files. Build the small,
 * durable environment Anima services need instead of copying the current
 * agent/tool shell, which may contain provider-specific or temporary paths.
 */
export function buildServiceEnvironment(options: ServiceEnvironmentOptions): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const baseEnv = cleanServiceEnv(options.baseEnv ?? process.env);
  const home = options.homeDir ?? baseEnv.HOME ?? homedir();
  const env: Record<string, string> = {
    ANIMA_HOME: options.animaHome,
    HOME: home,
    PATH: buildServicePath({
      homeDir: home,
      nodePath: options.nodePath ?? process.execPath,
      platform,
    }),
    SHELL: baseEnv.SHELL ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/sh'),
  };
  if (baseEnv.USER) env.USER = baseEnv.USER;
  if (baseEnv.LOGNAME) env.LOGNAME = baseEnv.LOGNAME;
  if (baseEnv.TMPDIR) env.TMPDIR = baseEnv.TMPDIR;
  return env;
}

export interface ServicePathOptions {
  homeDir?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
}

export function buildServicePath(options: ServicePathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const nodePath = options.nodePath ?? process.execPath;
  const entries = [
    dirname(nodePath),
    `${home}/.local/bin`,
    `${home}/.kimi-code/bin`,
    `${home}/.cargo/bin`,
    ...(platform === 'darwin'
      ? [
        '/opt/homebrew/opt/openjdk/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin',
        '/System/Cryptexes/App/usr/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ]
      : [
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ]),
  ];
  return dedupe(entries).join(delimiter);
}

function dedupe(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}
