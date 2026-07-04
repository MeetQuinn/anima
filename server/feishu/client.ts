import * as lark from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';

import {
  FEISHU_PROFILE_NAME_SCOPE,
  type AgentFeishuScopeGrant,
  type FeishuConfig,
} from '../../shared/agent-config.js';
import { asRecord, numberField, stringField } from '../json.js';
import type { FeishuMessageResourceType } from './feishu-file.service.js';
import type { FeishuPostContent } from './markdown-to-feishu-post.js';

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

export type FeishuPostSendInput = {
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  content: FeishuPostContent;
};

export interface FeishuPostReplyInput {
  messageId: string;
  replyInThread: boolean;
  content: FeishuPostContent;
}

export interface FeishuPostUpdateInput {
  messageId: string;
  content: FeishuPostContent;
}

export interface FeishuTextSendResult {
  chatId?: string;
  messageId?: string;
  threadId?: string;
}

export type FeishuUploadedFileKind = 'file' | 'image';

export interface FeishuFileUploadInput {
  bytes: Buffer;
  filename: string;
  mimetype: string;
}

export interface FeishuUploadedFile {
  fileKey: string;
  kind: FeishuUploadedFileKind;
}

export interface FeishuFileSendInput {
  file: FeishuUploadedFile;
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  threadMessageId?: string;
}

export interface FeishuMessageResourceDownloadInput {
  fileKey: string;
  messageId: string;
  resourceType: FeishuMessageResourceType;
}

export interface FeishuMessageResourceDownload {
  bytes: Buffer;
  contentType?: string;
  filename?: string;
}

export interface FeishuMessageListInput {
  chatId: string;
  cursor?: string;
  limit: number;
  threadId?: string;
}

export interface FeishuMessageListResult {
  hasMore: boolean;
  messages: FeishuConversationMessage[];
  nextCursor?: string;
}

export interface FeishuChatInfo {
  avatarUrl?: string;
  chatId: string;
  chatName?: string;
  chatType?: string;
}

export interface FeishuUserBasicInfo {
  i18nName?: Record<string, string>;
  name?: string;
  openId: string;
  unionId?: string;
  userId?: string;
}

export interface FeishuConversationMessage {
  bodyContent?: string;
  chatId?: string;
  chatType?: string;
  createTime?: string;
  deleted?: boolean;
  mentions?: FeishuConversationMention[];
  messageId: string;
  messageType?: string;
  parentId?: string;
  rootId?: string;
  sender?: FeishuConversationSender;
  threadId?: string;
  updated?: boolean;
}

export interface FeishuConversationMention {
  id?: string;
  idType?: string;
  key: string;
  name?: string;
  tenantKey?: string;
}

export interface FeishuConversationSender {
  id?: string;
  idType?: string;
  senderName?: string;
  senderType?: string;
  tenantKey?: string;
}

export interface FeishuMessageGetInput {
  messageId: string;
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
  downloadMessageResource(input: FeishuMessageResourceDownloadInput): Promise<FeishuMessageResourceDownload>;
  getChat?(input: { chatId: string }): Promise<FeishuChatInfo | undefined>;
  getMessage?(input: FeishuMessageGetInput): Promise<FeishuConversationMessage | undefined>;
  getUserBasics?(input: { openIds: string[] }): Promise<FeishuUserBasicInfo[]>;
  listMessages(input: FeishuMessageListInput): Promise<FeishuMessageListResult>;
  removeReaction(input: FeishuReactionRemoveInput): Promise<void>;
  replyText(input: FeishuTextReplyInput): Promise<FeishuTextSendResult>;
  replyPost(input: FeishuPostReplyInput): Promise<FeishuTextSendResult>;
  sendUploadedFile(input: FeishuFileSendInput): Promise<FeishuTextSendResult>;
  sendText(input: FeishuTextSendInput): Promise<FeishuTextSendResult>;
  sendPost(input: FeishuPostSendInput): Promise<FeishuTextSendResult>;
  updatePost?(input: FeishuPostUpdateInput): Promise<FeishuTextSendResult>;
  uploadFile(input: FeishuFileUploadInput): Promise<FeishuUploadedFile>;
}

export interface FeishuTenantAccessToken {
  expiresAt?: string;
  tenantAccessToken: string;
}

export interface FeishuBotInfo {
  appName?: string;
  avatarUrl?: string;
  openId?: string;
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
    msg_type: 'file' | 'image' | 'post' | 'text';
    receive_id: string;
  };
  params: {
    receive_id_type: FeishuReceiveIdType;
  };
}

interface FeishuSdkMessageReplyInput {
  data: {
    content: string;
    msg_type: 'file' | 'image' | 'post' | 'text';
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

interface FeishuSdkMessageListInput {
  params: {
    container_id: string;
    container_id_type: 'chat' | 'thread';
    page_size: number;
    page_token?: string;
    sort_type: 'ByCreateTimeDesc';
  };
}

interface FeishuSdkMessageGetInput {
  params?: {
    user_id_type?: 'open_id' | 'union_id' | 'user_id';
  };
  path: {
    message_id: string;
  };
}

interface FeishuSdkMessageListResult {
  data?: {
    has_more?: boolean;
    items?: FeishuSdkListedMessage[];
    page_token?: string;
  };
}

type FeishuSdkFileType = 'doc' | 'mp4' | 'opus' | 'pdf' | 'ppt' | 'stream' | 'xls';

interface FeishuSdkFileCreateInput {
  data: {
    file: Buffer;
    file_name: string;
    file_type: FeishuSdkFileType;
  };
}

interface FeishuSdkFileCreateResult {
  data?: {
    file_key?: string;
  };
  file_key?: string;
}

interface FeishuSdkImageCreateInput {
  data: {
    image: Buffer;
    image_type: 'message';
  };
}

interface FeishuSdkImageCreateResult {
  data?: {
    image_key?: string;
  };
  image_key?: string;
}

interface FeishuSdkListedMessage {
  body?: {
    content?: string;
  };
  chat_id?: string;
  chat_type?: string;
  create_time?: string;
  deleted?: boolean;
  mentions?: Array<{
    id?: string;
    id_type?: string;
    key?: string;
    name?: string;
    tenant_key?: string;
  }>;
  message_id?: string;
  msg_type?: string;
  parent_id?: string;
  root_id?: string;
  sender?: {
    id?: string;
    id_type?: string;
    sender_name?: string;
    sender_type?: string;
    tenant_key?: string;
  };
  thread_id?: string;
  updated?: boolean;
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

interface FeishuSdkMessageResourceGetInput {
  params: {
    // Feishu resource download API only accepts 'image' or 'file'.
    // Audio resources are stored as files and must use 'file' as the type.
    type: 'file' | 'image';
  };
  path: {
    file_key: string;
    message_id: string;
  };
}

interface FeishuSdkMessageResourceGetResult {
  getReadableStream(): Readable;
  headers?: Record<string, string | string[] | undefined>;
}

interface FeishuSdkMessageUpdateInput {
  data: {
    content: string;
    msg_type: 'post';
  };
  path: {
    message_id: string;
  };
}

interface FeishuSdkClient {
  request?(input: { data?: unknown; method: 'GET' | 'POST'; url: string }): Promise<unknown>;
  im: {
    file?: {
      create(input: FeishuSdkFileCreateInput): Promise<FeishuSdkFileCreateResult | null>;
    };
    image?: {
      create(input: FeishuSdkImageCreateInput): Promise<FeishuSdkImageCreateResult | null>;
    };
    message: {
      create(input: FeishuSdkMessageCreateInput): Promise<FeishuSdkMessageReplyResult>;
      get?(input: FeishuSdkMessageGetInput): Promise<FeishuSdkMessageListResult>;
      list?(input: FeishuSdkMessageListInput): Promise<FeishuSdkMessageListResult>;
      reply(input: FeishuSdkMessageReplyInput): Promise<FeishuSdkMessageReplyResult>;
      update?(input: FeishuSdkMessageUpdateInput): Promise<FeishuSdkMessageReplyResult>;
    };
    messageReaction: {
      create(input: FeishuSdkReactionCreateInput): Promise<FeishuSdkReactionCreateResult>;
      delete(input: FeishuSdkReactionDeleteInput): Promise<unknown>;
    };
    messageResource?: {
      get(input: FeishuSdkMessageResourceGetInput): Promise<FeishuSdkMessageResourceGetResult>;
    };
  };
}

interface FeishuOpenApiDeps {
  fetch?: typeof fetch;
  fetchFeishuTenantAccessToken?: typeof fetchFeishuTenantAccessToken;
}

interface FeishuMessageClientDeps extends FeishuOpenApiDeps {
  createClient?(config: FeishuConfig): FeishuSdkClient;
}

export class FeishuApiError extends Error {
  readonly code: string;
  readonly vendorMessage?: string;

  constructor(input: { code: number | string; operation: string; vendorMessage?: string }) {
    const code = String(input.code);
    const suffix = input.vendorMessage ?? `code ${code}`;
    super(`${input.operation}: ${suffix}`);
    this.name = 'FeishuApiError';
    this.code = code;
    if (input.vendorMessage) this.vendorMessage = input.vendorMessage;
  }
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
    throw feishuApiError('Feishu tenant_access_token request failed', code, payload);
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

export async function fetchFeishuBotInfo(
  config: FeishuConfig,
  deps: FeishuMessageClientDeps = {},
): Promise<FeishuBotInfo> {
  const client = feishuSdkClient(config, deps);
  if (!client.request) {
    throw new Error('Feishu SDK client does not support generic request');
  }
  const response = asRecord(await client.request({
    method: 'GET',
    url: '/open-apis/bot/v3/info',
  }));
  const code = numberField(response, 'code');
  if (code !== undefined && code !== 0) {
    throw feishuApiError('Feishu bot info request failed', code, response);
  }
  const bot = asRecord(response?.bot) ?? asRecord(asRecord(response?.data)?.bot);
  if (!bot) {
    throw new Error('Feishu bot info response did not include bot');
  }
  const appName = stringField(bot, 'app_name');
  const avatarUrl = stringField(bot, 'avatar_url');
  const openId = stringField(bot, 'open_id');
  return {
    ...(appName ? { appName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(openId ? { openId } : {}),
  };
}

export async function fetchFeishuAppScopes(
  config: FeishuConfig,
  deps: FeishuOpenApiDeps = {},
): Promise<AgentFeishuScopeGrant[]> {
  const response = asRecord(await feishuOpenApiRequester(config, deps)({
    method: 'GET',
    path: '/application/v6/scopes',
  }));
  const code = numberField(response, 'code');
  if (code !== undefined && code !== 0) {
    throw feishuApiError('Feishu scope status request failed', code, response);
  }
  const data = asRecord(response?.data);
  const scopes = Array.isArray(data?.scopes) ? data.scopes : [];
  return scopes.flatMap((scope): AgentFeishuScopeGrant[] => {
    const entry = asRecord(scope);
    const scopeName = stringField(entry, 'scope_name');
    if (!scopeName) return [];
    const grantStatus = numberField(entry, 'grant_status');
    return [{
      granted: grantStatus === 1,
      ...(grantStatus !== undefined ? { grantStatus } : {}),
      scopeName,
    }];
  });
}

export function feishuScopeAuthUrl(appId: string, scopes: readonly string[]): string | undefined {
  const cleanAppId = appId.trim();
  if (!cleanAppId) return undefined;
  const cleanScopes = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (!cleanScopes.length) return undefined;
  const q = cleanScopes.map((scope) => encodeURIComponent(scope)).join(',');
  return `https://open.feishu.cn/app/${encodeURIComponent(cleanAppId)}/auth?op_from=openapi&q=${q}&token_type=tenant`;
}

export function feishuProfileNameScopeAuthUrl(appId: string): string | undefined {
  return feishuScopeAuthUrl(appId, [FEISHU_PROFILE_NAME_SCOPE]);
}

export function createFeishuMessageClient(config: FeishuConfig, deps: FeishuMessageClientDeps = {}): FeishuMessageClient {
  const client: FeishuSdkClient = feishuSdkClient(config, deps);
  const openApi = feishuOpenApiRequester(config, deps);
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
    async listMessages(input) {
      if (!client.im.message.list) {
        throw new Error('Feishu SDK client does not support message.list');
      }
      const containerId = input.threadId ?? input.chatId;
      const containerIdType = input.threadId ? 'thread' : 'chat';
      const response = await client.im.message.list({
        params: {
          container_id: containerId,
          container_id_type: containerIdType,
          ...(input.cursor ? { page_token: input.cursor } : {}),
          page_size: input.limit,
          sort_type: 'ByCreateTimeDesc',
        },
      });
      return {
        hasMore: Boolean(response.data?.has_more),
        messages: feishuConversationMessagesFromSdk(response.data?.items),
        ...(response.data?.page_token ? { nextCursor: response.data.page_token } : {}),
      };
    },
    async getMessage(input) {
      if (!client.im.message.get) {
        throw new Error('Feishu SDK client does not support message.get');
      }
      const response = await client.im.message.get({
        path: {
          message_id: input.messageId,
        },
      });
      return feishuConversationMessagesFromSdk(response.data?.items)[0];
    },
    async getChat(input) {
      const response = asRecord(await openApi({
        method: 'GET',
        path: `/im/v1/chats/${encodeURIComponent(input.chatId)}`,
      }));
      const code = numberField(response, 'code');
      if (code !== undefined && code !== 0) {
        throw feishuApiError('Feishu chat info request failed', code, response);
      }
      const data = asRecord(response?.data);
      const chat = asRecord(data?.chat) ?? data;
      const chatId = stringField(chat, 'chat_id') ?? input.chatId;
      const avatarUrl = stringField(chat, 'avatar') ?? stringField(chat, 'avatar_url');
      const chatName = stringField(chat, 'name');
      const chatType = stringField(chat, 'chat_type');
      return {
        ...(avatarUrl ? { avatarUrl } : {}),
        chatId,
        ...(chatName ? { chatName } : {}),
        ...(chatType ? { chatType } : {}),
      };
    },
    async getUserBasics(input) {
      const openIds = [...new Set(input.openIds.map((id) => id.trim()).filter(Boolean))].slice(0, 10);
      if (!openIds.length) return [];
      const response = asRecord(await openApi({
        data: { user_ids: openIds },
        method: 'POST',
        path: '/contact/v3/users/basic_batch?user_id_type=open_id',
      }));
      const code = numberField(response, 'code');
      if (code !== undefined && code !== 0) {
        throw feishuApiError('Feishu user basic request failed', code, response);
      }
      const data = asRecord(response?.data);
      const users = Array.isArray(data?.users) ? data.users : [];
      return users.flatMap((entry) => {
        const user = asRecord(entry);
        const openId = stringField(user, 'user_id') ?? stringField(user, 'open_id');
        if (!openId) return [];
        const i18nName = recordOfStrings(asRecord(user?.i18n_name));
        const name = stringField(user, 'name');
        const unionId = stringField(user, 'union_id');
        const userId = stringField(user, 'user_id');
        return [{
          ...(i18nName ? { i18nName } : {}),
          ...(name ? { name } : {}),
          openId,
          ...(unionId ? { unionId } : {}),
          ...(userId && userId !== openId ? { userId } : {}),
        }];
      });
    },
    async updatePost(input) {
      if (!client.im.message.update) {
        throw new Error('Feishu SDK client does not support message.update');
      }
      const response = await client.im.message.update({
        data: {
          content: JSON.stringify(input.content),
          msg_type: 'post',
        },
        path: {
          message_id: input.messageId,
        },
      });
      return {
        ...(response.data?.chat_id ? { chatId: response.data.chat_id } : {}),
        messageId: response.data?.message_id ?? input.messageId,
        ...(response.data?.thread_id ? { threadId: response.data.thread_id } : {}),
      };
    },
    async downloadMessageResource(input) {
      if (!client.im.messageResource?.get) {
        throw new Error('Feishu SDK client does not support messageResource.get');
      }
      const response = await client.im.messageResource.get({
        params: {
          // Audio resources are stored as files in Feishu; use 'file' type for download.
          type: input.resourceType === 'image' ? 'image' : 'file',
        },
        path: {
          file_key: input.fileKey,
          message_id: input.messageId,
        },
      });
      const bytes = await readableToBuffer(response.getReadableStream());
      assertFeishuDownloadSize(bytes.length);
      return {
        bytes,
        ...(contentDispositionFilename(headerValue(response.headers, 'content-disposition')) ? {
          filename: contentDispositionFilename(headerValue(response.headers, 'content-disposition')),
        } : {}),
        ...(headerValue(response.headers, 'content-type') ? { contentType: headerValue(response.headers, 'content-type') } : {}),
      };
    },
    async uploadFile(input) {
      if (isFeishuImageUpload(input)) {
        if (!client.im.image?.create) {
          throw new Error('Feishu SDK client does not support image.create');
        }
        const response = await client.im.image.create({
          data: {
            image: input.bytes,
            image_type: 'message',
          },
        });
        const fileKey = response?.data?.image_key ?? response?.image_key;
        if (!fileKey) {
          throw new Error('Feishu image upload response did not include image_key');
        }
        return { fileKey, kind: 'image' };
      }

      if (!client.im.file?.create) {
        throw new Error('Feishu SDK client does not support file.create');
      }
      const response = await client.im.file.create({
        data: {
          file: input.bytes,
          file_name: input.filename,
          file_type: feishuFileTypeFor(input),
        },
      });
      const fileKey = response?.data?.file_key ?? response?.file_key;
      if (!fileKey) {
        throw new Error('Feishu file upload response did not include file_key');
      }
      return { fileKey, kind: 'file' };
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
    async replyPost(input) {
      const response = await client.im.message.reply({
        data: {
          content: JSON.stringify(input.content),
          msg_type: 'post',
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
    async sendUploadedFile(input) {
      const msgType = input.file.kind;
      const content = input.file.kind === 'image'
        ? { image_key: input.file.fileKey }
        : { file_key: input.file.fileKey };
      const response = input.threadMessageId
        ? await client.im.message.reply({
            data: {
              content: JSON.stringify(content),
              msg_type: msgType,
              reply_in_thread: true,
            },
            path: {
              message_id: input.threadMessageId,
            },
          })
        : await client.im.message.create({
            data: {
              content: JSON.stringify(content),
              msg_type: msgType,
              receive_id: input.receiveId,
            },
            params: {
              receive_id_type: input.receiveIdType,
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
    async sendPost(input) {
      const response = await client.im.message.create({
        data: {
          content: JSON.stringify(input.content),
          msg_type: 'post',
          receive_id: input.receiveId,
        },
        params: {
          receive_id_type: input.receiveIdType,
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

function feishuOpenApiRequester(
  config: FeishuConfig,
  deps: FeishuOpenApiDeps,
): (input: { data?: unknown; method: 'GET' | 'POST'; path: string }) => Promise<unknown> {
  const fetchImpl = deps.fetch ?? fetch;
  let cachedToken: Promise<FeishuTenantAccessToken> | undefined;
  return async (input) => {
    cachedToken ??= (deps.fetchFeishuTenantAccessToken ?? fetchFeishuTenantAccessToken)(config);
    const token = await cachedToken;
    const response = await fetchImpl(`${FEISHU_OPEN_API_BASE_URL}${input.path}`, {
      ...(input.data !== undefined ? { body: JSON.stringify(input.data) } : {}),
      headers: {
        Authorization: `Bearer ${token.tenantAccessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      method: input.method,
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      throw new Error(`Feishu OpenAPI request failed with HTTP ${response.status}: ${stringField(payload, 'msg') ?? response.statusText}`);
    }
    return payload;
  };
}

function feishuApiError(operation: string, code: number, payload: Record<string, unknown> | undefined): FeishuApiError {
  const vendorMessage = stringField(payload, 'msg');
  return new FeishuApiError({
    code,
    operation,
    ...(vendorMessage ? { vendorMessage } : {}),
  });
}

function feishuSdkClient(config: FeishuConfig, deps: FeishuMessageClientDeps): FeishuSdkClient {
  return deps.createClient?.(config) ?? (new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    source: 'anima',
  }) as unknown as FeishuSdkClient);
}

function feishuConversationMessagesFromSdk(items: FeishuSdkListedMessage[] | undefined): FeishuConversationMessage[] {
  return (items ?? [])
    .filter((item): item is FeishuSdkListedMessage & { message_id: string } => typeof item.message_id === 'string')
    .map((item) => ({
      ...(item.body?.content ? { bodyContent: item.body.content } : {}),
      ...(item.chat_id ? { chatId: item.chat_id } : {}),
      ...(item.chat_type ? { chatType: item.chat_type } : {}),
      ...(item.create_time ? { createTime: item.create_time } : {}),
      ...(item.deleted !== undefined ? { deleted: item.deleted } : {}),
      ...(item.mentions?.length ? { mentions: feishuMentionsFromSdk(item.mentions) } : {}),
      messageId: item.message_id,
      ...(item.msg_type ? { messageType: item.msg_type } : {}),
      ...(item.parent_id ? { parentId: item.parent_id } : {}),
      ...(item.root_id ? { rootId: item.root_id } : {}),
      ...(item.sender ? { sender: feishuSenderFromSdk(item.sender) } : {}),
      ...(item.thread_id ? { threadId: item.thread_id } : {}),
      ...(item.updated !== undefined ? { updated: item.updated } : {}),
    }));
}

function feishuMentionsFromSdk(
  mentions: NonNullable<FeishuSdkListedMessage['mentions']>,
): FeishuConversationMention[] {
  return mentions
    .filter((mention): mention is NonNullable<FeishuSdkListedMessage['mentions']>[number] & { key: string } =>
      typeof mention.key === 'string' && mention.key.length > 0)
    .map((mention) => ({
      ...(mention.id ? { id: mention.id } : {}),
      ...(mention.id_type ? { idType: mention.id_type } : {}),
      key: mention.key,
      ...(mention.name ? { name: mention.name } : {}),
      ...(mention.tenant_key ? { tenantKey: mention.tenant_key } : {}),
    }));
}

function feishuSenderFromSdk(
  sender: NonNullable<FeishuSdkListedMessage['sender']>,
): FeishuConversationSender {
  return {
    ...(sender.id ? { id: sender.id } : {}),
    ...(sender.id_type ? { idType: sender.id_type } : {}),
    ...(sender.sender_name ? { senderName: sender.sender_name } : {}),
    ...(sender.sender_type ? { senderType: sender.sender_type } : {}),
    ...(sender.tenant_key ? { tenantKey: sender.tenant_key } : {}),
  };
}

export function createFeishuEventDispatcher(input: {
  config: FeishuConfig;
  onReactionCreated?(data: unknown): Promise<void>;
  onReceiveMessage(data: unknown): Promise<void>;
}): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({
    encryptKey: input.config.encryptKey,
    verificationToken: input.config.verificationToken,
  }).register({
    'im.message.receive_v1': (data) => input.onReceiveMessage(data),
  });
  if (input.onReactionCreated) {
    dispatcher.register({
      'im.message.reaction.created_v1': (data) => input.onReactionCreated!(data),
    });
  }
  return dispatcher;
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

async function readableToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(bytes);
    size += bytes.length;
    assertFeishuDownloadSize(size);
  }
  return Buffer.concat(chunks);
}

function assertFeishuDownloadSize(sizeBytes: number): void {
  const max = 100 * 1024 * 1024;
  if (sizeBytes > max) {
    throw new Error(`Feishu message resource exceeds ${max} bytes`);
  }
}

function headerValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}

function contentDispositionFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return /filename="?([^";]+)"?/i.exec(value)?.[1];
}

function isFeishuImageUpload(input: FeishuFileUploadInput): boolean {
  return isFeishuImageMimetype(input.mimetype) || isFeishuImageName(input.filename);
}

function isFeishuImageMimetype(mimetype: string): boolean {
  return [
    'image/bmp',
    'image/gif',
    'image/ico',
    'image/jpeg',
    'image/png',
    'image/tiff',
    'image/vnd.microsoft.icon',
    'image/webp',
    'image/x-icon',
  ].includes(mimetype.toLowerCase());
}

function isFeishuImageName(filename: string): boolean {
  return /\.(bmp|gif|ico|jpe?g|png|tiff?|webp)$/i.test(filename);
}

function recordOfStrings(record: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && value.trim()) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function feishuFileTypeFor(input: FeishuFileUploadInput): FeishuSdkFileType {
  const name = input.filename.toLowerCase();
  const mimetype = input.mimetype.toLowerCase();
  if (name.endsWith('.pdf') || mimetype === 'application/pdf') return 'pdf';
  if (
    /\.(doc|docx)$/i.test(name)
    || mimetype === 'application/msword'
    || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'doc';
  }
  if (
    /\.(xls|xlsx|csv)$/i.test(name)
    || mimetype === 'application/vnd.ms-excel'
    || mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || mimetype === 'text/csv'
  ) {
    return 'xls';
  }
  if (
    /\.(ppt|pptx)$/i.test(name)
    || mimetype === 'application/vnd.ms-powerpoint'
    || mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return 'ppt';
  }
  if (name.endsWith('.opus') || mimetype === 'audio/opus') return 'opus';
  if (name.endsWith('.mp4') || mimetype === 'video/mp4') return 'mp4';
  return 'stream';
}
