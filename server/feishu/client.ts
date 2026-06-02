import * as lark from '@larksuiteoapi/node-sdk';

import type { FeishuConfig } from '../../shared/agent-config.js';

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
