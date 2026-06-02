import * as lark from '@larksuiteoapi/node-sdk';

import type { FeishuConfig } from '../../shared/agent-config.js';
import { asRecord, numberField, stringField } from '../json.js';

export const FEISHU_OPEN_API_BASE_URL = 'https://open.feishu.cn/open-apis';

export interface FeishuTextSendInput {
  chatId: string;
  text: string;
}

export interface FeishuTextReplyInput {
  messageId: string;
  replyInThread: boolean;
  text: string;
}

export interface FeishuTextSendResult {
  chatId?: string;
  messageId?: string;
  threadId?: string;
}

export interface FeishuMessageClient {
  replyText(input: FeishuTextReplyInput): Promise<FeishuTextSendResult>;
  sendText(input: FeishuTextSendInput): Promise<FeishuTextSendResult>;
}

export interface FeishuTenantAccessToken {
  expiresAt?: string;
  tenantAccessToken: string;
}

type FetchLike = (
  url: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: 'POST';
  },
) => Promise<{
  json(): Promise<unknown>;
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

interface FeishuTenantAccessTokenDeps {
  apiBaseUrl?: string;
  fetch?: FetchLike;
  nowMs?: () => number;
}

interface FeishuSdkMessageCreateInput {
  data: {
    content: string;
    msg_type: 'text';
    receive_id: string;
  };
  params: {
    receive_id_type: 'chat_id';
  };
}

interface FeishuSdkMessageReplyInput {
  data: {
    content: string;
    msg_type: 'text';
    reply_in_thread: boolean;
  };
  path: {
    message_id: string;
  };
}

interface FeishuSdkMessageReplyResult {
  data?: {
    chat_id?: string;
    message_id?: string;
    thread_id?: string;
  };
}

interface FeishuSdkClient {
  im: {
    message: {
      create(input: FeishuSdkMessageCreateInput): Promise<FeishuSdkMessageReplyResult>;
      reply(input: FeishuSdkMessageReplyInput): Promise<FeishuSdkMessageReplyResult>;
    };
  };
}

interface FeishuMessageClientDeps {
  createClient?(config: FeishuConfig): FeishuSdkClient;
}

export async function fetchFeishuTenantAccessToken(
  config: FeishuConfig,
  deps: FeishuTenantAccessTokenDeps = {},
): Promise<FeishuTenantAccessToken> {
  if (!config.appId || !config.appSecret) {
    throw new Error('Feishu appId and appSecret are required to mint a tenant_access_token');
  }
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const response = await fetchImpl(
    `${trimTrailingSlash(deps.apiBaseUrl ?? FEISHU_OPEN_API_BASE_URL)}/auth/v3/tenant_access_token/internal`,
    {
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    },
  );
  if (!response.ok) {
    throw new Error(`Feishu tenant_access_token request failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const payload = asRecord(await response.json());
  const data = asRecord(payload?.data);
  const code = numberField(payload, 'code');
  if (code !== undefined && code !== 0) {
    throw new Error(`Feishu tenant_access_token request failed: ${stringField(payload, 'msg') ?? `code ${code}`}`);
  }
  const tenantAccessToken = stringField(payload, 'tenant_access_token')
    ?? stringField(data, 'tenant_access_token');
  if (!tenantAccessToken) {
    throw new Error('Feishu tenant_access_token response did not include tenant_access_token');
  }
  const expireSeconds = numberField(payload, 'expire') ?? numberField(data, 'expire');
  const expiresAt = expireSeconds !== undefined
    ? new Date((deps.nowMs?.() ?? Date.now()) + expireSeconds * 1000).toISOString()
    : undefined;
  return {
    ...(expiresAt ? { expiresAt } : {}),
    tenantAccessToken,
  };
}

export function createFeishuMessageClient(config: FeishuConfig, deps: FeishuMessageClientDeps = {}): FeishuMessageClient {
  const client = deps.createClient?.(config) ?? new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    source: 'anima',
  });
  return {
    async replyText(input) {
      const response = await client.im.message.reply({
        data: {
          content: JSON.stringify({ text: input.text }),
          msg_type: 'text',
          reply_in_thread: input.replyInThread,
        },
        path: {
          message_id: input.messageId,
        },
      });
      return {
        ...(response.data?.chat_id ? { chatId: response.data.chat_id } : {}),
        ...(response.data?.message_id ? { messageId: response.data.message_id } : {}),
        ...(response.data?.thread_id ? { threadId: response.data.thread_id } : {}),
      };
    },
    async sendText(input) {
      const response = await client.im.message.create({
        data: {
          content: JSON.stringify({ text: input.text }),
          msg_type: 'text',
          receive_id: input.chatId,
        },
        params: {
          receive_id_type: 'chat_id',
        },
      });
      return {
        ...(response.data?.chat_id ? { chatId: response.data.chat_id } : {}),
        ...(response.data?.message_id ? { messageId: response.data.message_id } : {}),
        ...(response.data?.thread_id ? { threadId: response.data.thread_id } : {}),
      };
    },
  };
}

export function createFeishuEventDispatcher(input: {
  config: FeishuConfig;
  onReceiveMessage(data: unknown): Promise<void>;
}): lark.EventDispatcher {
  return new lark.EventDispatcher({
    encryptKey: input.config.encryptKey,
    verificationToken: input.config.verificationToken,
  }).register({
    'im.message.receive_v1': (data) => input.onReceiveMessage(data),
  });
}

export function createFeishuWsClient(config: FeishuConfig): lark.WSClient {
  return new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    autoReconnect: true,
    domain: lark.Domain.Feishu,
    source: 'anima',
  });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
