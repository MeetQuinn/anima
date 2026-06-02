import * as lark from '@larksuiteoapi/node-sdk';

import type { FeishuConfig } from '../../shared/agent-config.js';

export interface FeishuTextReplyInput {
  messageId: string;
  text: string;
}

export interface FeishuTextReplyResult {
  chatId?: string;
  messageId?: string;
  threadId?: string;
}

export interface FeishuMessageClient {
  replyText(input: FeishuTextReplyInput): Promise<FeishuTextReplyResult>;
}

export function createFeishuMessageClient(config: FeishuConfig): FeishuMessageClient {
  const client = new lark.Client({
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
          reply_in_thread: true,
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
