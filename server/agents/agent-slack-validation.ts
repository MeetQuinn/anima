import type { WebClient } from '@slack/web-api';

import {
  type AgentSlackValidateRequest,
  type AgentSlackValidateResponse,
  type SlackConnectionValidation,
  type SlackTokenKind,
  type SlackTokenValidation,
  type SlackTokenValidationReason,
} from '../../shared/agent-config.js';
import { isRecord } from '../json.js';
import { createSlackWebClient } from '../slack/client.js';
import { SlackWorkspaceDirectoryService, type SlackUserInfo } from '../slack/workspace-directory.service.js';
import { parseOauthScopesHeader } from '../slack/shortcuts.js';

export interface SlackDisplayInfo {
  appId?: string;
  avatarUrl?: string;
  botHandle?: string;
  botName?: string;
  botUserId?: string;
  teamId?: string;
  workspaceIconUrl?: string;
  workspaceName?: string;
}

const APP_TOKEN_APP_ID_PATTERN = /^xapp-\d+-(A[A-Z0-9]+)-/;

export async function validateSlackTokenPair(
  input: AgentSlackValidateRequest,
): Promise<AgentSlackValidateResponse> {
  const app = input.appToken !== undefined
    ? await validateSlackToken('app', input.appToken)
    : undefined;
  const bot = input.botToken !== undefined
    ? await validateSlackToken('bot', input.botToken)
    : undefined;
  return {
    ...(app ? { app } : {}),
    ...(bot ? { bot } : {}),
    connection: slackConnectionValidation(app, bot),
  };
}

export async function getSlackDisplayInfo(client: WebClient): Promise<SlackDisplayInfo> {
  const auth = await client.auth.test();
  if (!auth.user_id) throw new Error('Slack auth.test did not return a bot user id');
  // Fetch the bot user profile directly (bypasses WorkspaceDirectoryService cache)
  // so avatar changes take effect immediately on sync without requiring a full
  // workspace directory refresh.
  const userInfo = await client.users.info({ user: auth.user_id });
  const user = userInfo.user as SlackUserInfo | undefined;
  const directory = new SlackWorkspaceDirectoryService({ client, teamId: auth.team_id });
  const botHandle = user?.name?.trim() || (typeof auth.user === 'string' ? auth.user.trim() : '') || undefined;
  const botName = directory.getUserDisplayName(user, (typeof auth.user === 'string' ? auth.user.trim() : '') || auth.user_id);
  const workspaceIconUrl = await directory.getWorkspaceIconUrl().catch(() => '');
  return {
    appId: auth.app_id,
    avatarUrl: user?.profile?.image_72 ?? '',
    botHandle,
    botName,
    botUserId: auth.user_id,
    teamId: auth.team_id ?? '',
    workspaceIconUrl,
    workspaceName: auth.team ?? '',
  };
}

export function appIdFromAppToken(token: string | undefined): string | undefined {
  return token?.match(APP_TOKEN_APP_ID_PATTERN)?.[1];
}

export async function getBotTokenScopes(token: string): Promise<string[]> {
  const response = await fetch(slackApiMethodUrl('auth.test'), {
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  });
  const result = await response.json() as { error?: string; ok?: boolean };
  if (!result.ok) throw new Error(`Slack auth.test failed: ${result.error ?? 'unknown_error'}`);
  return parseOauthScopesHeader(response.headers.get('x-oauth-scopes'));
}

async function validateSlackToken(
  expected: Exclude<SlackTokenKind, 'unknown'>,
  rawToken: string,
): Promise<SlackTokenValidation> {
  const token = rawToken.trim();
  if (!token) return invalidTokenValidation('unknown', expected, 'missing_token');
  const detected = slackTokenKind(token);
  if (detected === 'unknown') return invalidTokenValidation(detected, expected, 'unknown_token_type');
  if (detected !== expected) return invalidTokenValidation(detected, expected, 'wrong_token_type');

  return expected === 'app'
    ? validateAppToken(token)
    : validateBotToken(token);
}

async function validateAppToken(token: string): Promise<SlackTokenValidation> {
  const appId = appIdFromAppToken(token);
  try {
    await createSlackWebClient(token).apps.connections.open({});
    return { ...(appId ? { appId } : {}), detected: 'app', expected: 'app', valid: true };
  } catch (error) {
    return {
      ...(appId ? { appId } : {}),
      detected: 'app',
      expected: 'app',
      reason: tokenValidationReason(error, 'app'),
      valid: false,
    };
  }
}

async function validateBotToken(token: string): Promise<SlackTokenValidation> {
  try {
    const info = await getSlackDisplayInfo(createSlackWebClient(token));
    return {
      appId: info.appId,
      botAvatarUrl: info.avatarUrl,
      botHandle: info.botHandle,
      botName: info.botName,
      botUserId: info.botUserId,
      detected: 'bot',
      expected: 'bot',
      teamId: info.teamId,
      valid: true,
      workspaceIconUrl: info.workspaceIconUrl,
      workspaceName: info.workspaceName,
    };
  } catch (error) {
    return { detected: 'bot', expected: 'bot', reason: tokenValidationReason(error, 'bot'), valid: false };
  }
}

function invalidTokenValidation(
  detected: SlackTokenKind,
  expected: Exclude<SlackTokenKind, 'unknown'>,
  reason: SlackTokenValidationReason,
): SlackTokenValidation {
  return { detected, expected, reason, valid: false };
}

function slackTokenKind(token: string): SlackTokenKind {
  if (token.startsWith('xapp-')) return 'app';
  if (token.startsWith('xoxb-')) return 'bot';
  return 'unknown';
}

function slackApiMethodUrl(method: string): string {
  const base = process.env.ANIMA_SLACK_API_URL ?? 'https://slack.com/api';
  return `${base.replace(/\/$/, '')}/${method}`;
}

function slackConnectionValidation(
  app: SlackTokenValidation | undefined,
  bot: SlackTokenValidation | undefined,
): SlackConnectionValidation {
  if (!app?.valid || !bot?.valid) return { reason: 'incomplete', valid: false };
  const base = {
    appId: bot.appId ?? app.appId,
    botAvatarUrl: bot.botAvatarUrl,
    botHandle: bot.botHandle,
    botName: bot.botName,
    botUserId: bot.botUserId,
    teamId: bot.teamId,
    workspaceIconUrl: bot.workspaceIconUrl,
    workspaceName: bot.workspaceName,
  };
  if (app.appId && bot.appId && app.appId !== bot.appId) {
    return { ...base, reason: 'app_mismatch', valid: false };
  }
  return { ...base, valid: true };
}

function slackErrorCode(error: unknown): string | undefined {
  const data = isRecord(error) ? error['data'] : undefined;
  if (isRecord(data) && typeof data['error'] === 'string') return data['error'];
  if (isRecord(error) && typeof error['code'] === 'string') return error['code'];
  return undefined;
}

function tokenValidationReason(error: unknown, kind: 'app' | 'bot'): SlackTokenValidationReason {
  const code = slackErrorCode(error);
  if (code === 'missing_scope' && kind === 'app') return 'missing_connections_write';
  if (code === 'invalid_auth' || code === 'not_authed' || code === 'token_revoked' || code === 'account_inactive') {
    return 'invalid_token';
  }
  if (kind === 'bot' && error instanceof Error && /bot user id/i.test(error.message)) return 'not_bot_token';
  return 'slack_api_error';
}
