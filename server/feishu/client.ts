import * as lark from '@larksuiteoapi/node-sdk';

import type { FeishuConfig } from '../../shared/agent-config.js';
import { asRecord, numberField, stringField } from '../json.js';

export const FEISHU_OPEN_API_BASE_URL = 'https://open.feishu.cn/open-apis';

export type FeishuReceiveIdType = 'chat_id' | 'open_id';

export type FeishuTextSendInput = {
  chatId: string;
  text: string;
} | {
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  text: string;
};

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

export interface FeishuReactionAddInput {
  emojiType: string;
  messageId: string;
}

export interface FeishuReactionAddResult {
  reactionId: string;
}

export interface FeishuReactionRemoveInput {
  messageId: string;
  reactionId: string;
}

export interface FeishuMessageClient {
  addReaction(input: FeishuReactionAddInput): Promise<FeishuReactionAddResult>;
  removeReaction(input: FeishuReactionRemoveInput): Promise<void>;
  replyText(input: FeishuTextReplyInput): Promise<FeishuTextSendResult>;
  sendText(input: FeishuTextSendInput): Promise<FeishuTextSendResult>;
}

export interface FeishuTenantAccessToken {
  expiresAt?: string;
  tenantAccessToken: string;
}

export interface FeishuRegisterAppInput {
  appPreset?: {
    avatar?: string | string[];
    desc?: string;
    name?: string;
  };
  onQRCodeReady(info: { expireIn: number; url: string }): void;
  onStatusChange?(info: { interval?: number; status: 'polling' | 'slow_down' | 'domain_switched' }): void;
  signal?: AbortSignal;
  source?: string;
}

export interface FeishuRegisterAppResult {
  appId: string;
  appSecret: string;
  tenantBrand?: 'feishu' | 'lark';
  userOpenId?: string;
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
    receive_id_type: FeishuReceiveIdType;
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

interface FeishuSdkReactionCreateInput {
  data: {
    reaction_type: {
      emoji_type: string;
    };
  };
  path: {
    message_id: string;
  };
}

interface FeishuSdkReactionCreateResult {
  data?: {
    reaction_id?: string;
  };
}

interface FeishuSdkReactionDeleteInput {
  path: {
    message_id: string;
    reaction_id: string;
  };
}

interface FeishuSdkClient {
  im: {
    message: {
      create(input: FeishuSdkMessageCreateInput): Promise<FeishuSdkMessageReplyResult>;
      reply(input: FeishuSdkMessageReplyInput): Promise<FeishuSdkMessageReplyResult>;
    };
    messageReaction: {
      create(input: FeishuSdkReactionCreateInput): Promise<FeishuSdkReactionCreateResult>;
      delete(input: FeishuSdkReactionDeleteInput): Promise<unknown>;
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

export async function registerFeishuApp(input: FeishuRegisterAppInput): Promise<FeishuRegisterAppResult> {
  const result = await lark.registerApp({
    ...(input.appPreset ? { appPreset: input.appPreset } : {}),
    onQRCodeReady: input.onQRCodeReady,
    onStatusChange: input.onStatusChange,
    ...(input.signal ? { signal: input.signal } : {}),
    source: input.source ?? 'anima',
  });
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    ...(result.user_info?.tenant_brand ? { tenantBrand: result.user_info.tenant_brand } : {}),
    ...(result.user_info?.open_id ? { userOpenId: result.user_info.open_id } : {}),
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
    async addReaction(input) {
      const response = await client.im.messageReaction.create({
        data: {
          reaction_type: { emoji_type: input.emojiType },
        },
        path: {
          message_id: input.messageId,
        },
      });
      const reactionId = response.data?.reaction_id;
      if (!reactionId) {
        throw new Error('Feishu reaction create response did not include reaction_id');
      }
      return { reactionId };
    },
    async removeReaction(input) {
      await client.im.messageReaction.delete({
        path: {
          message_id: input.messageId,
          reaction_id: input.reactionId,
        },
      });
    },
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
      const target = feishuSendTarget(input);
      const response = await client.im.message.create({
        data: {
          content: JSON.stringify({ text: input.text }),
          msg_type: 'text',
          receive_id: target.receiveId,
        },
        params: {
          receive_id_type: target.receiveIdType,
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

function feishuSendTarget(input: FeishuTextSendInput): {
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
} {
  if ('chatId' in input) return { receiveId: input.chatId, receiveIdType: 'chat_id' };
  return { receiveId: input.receiveId, receiveIdType: input.receiveIdType };
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
