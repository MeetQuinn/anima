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
