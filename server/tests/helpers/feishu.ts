import { waitFor } from './harness.js';
import { type FeishuReceiveMessageEvent } from '../../feishu/events.js';
import { FeishuMessageTransport } from '../../transports/feishu-message-transport.js';
import { AgentFeishuService } from '../../agents/agent-feishu.service.js';
import type { FeishuMessageClient } from '../../feishu/client.js';
import type { FeishuConfig } from '../../../shared/agent-config.js';

export function makeFeishuEvent(overrides: Omit<Partial<FeishuReceiveMessageEvent>, 'message' | 'sender'> & {
  message?: Partial<FeishuReceiveMessageEvent['message']>;
  sender?: Partial<FeishuReceiveMessageEvent['sender']> & {
    sender_id?: Partial<NonNullable<FeishuReceiveMessageEvent['sender']['sender_id']>>;
  };
} = {}): FeishuReceiveMessageEvent {
  const { message, sender, ...rest } = overrides;
  return {
    app_id: 'cli_test',
    create_time: '1780410000000',
    event_id: 'evt-feishu-1',
    tenant_key: 'tenant_test',
    ...rest,
    message: {
      chat_id: 'oc_test_chat',
      chat_type: 'p2p',
      content: JSON.stringify({ text: 'hello from Feishu' }),
      create_time: '1780410000000',
      message_id: 'om_test_message',
      message_type: 'text',
      ...message,
    },
    sender: {
      ...sender,
      sender_id: {
        open_id: 'ou_alice',
        union_id: 'on_alice',
        user_id: 'user_alice',
        ...sender?.sender_id,
      },
      sender_type: sender?.sender_type ?? 'user',
      tenant_key: sender?.tenant_key ?? 'tenant_test',
    },
  };
}

export function testFeishuMessageClient(overrides: Partial<FeishuMessageClient> = {}): FeishuMessageClient {
  return {
    async addReaction() {
      throw new Error('unexpected reaction add');
    },
    async downloadMessageResource() {
      throw new Error('unexpected file fetch');
    },
    async listMessages() {
      throw new Error('unexpected list messages');
    },
    async removeReaction() {
      throw new Error('unexpected reaction remove');
    },
    async replyPost() {
      throw new Error('unexpected post reply');
    },
    async replyText() {
      throw new Error('unexpected text reply');
    },
    async sendPost() {
      throw new Error('unexpected post send');
    },
    async sendText() {
      throw new Error('unexpected text send');
    },
    async sendUploadedFile() {
      throw new Error('unexpected file send');
    },
    async uploadFile() {
      throw new Error('unexpected file upload');
    },
    ...overrides,
  };
}

export function jsonResponse(payload: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    json: async () => payload,
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
  } as Response;
}

export function feishuTransportConfig(overrides: Partial<FeishuConfig> = {}): FeishuConfig {
  return {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
    ...overrides,
  };
}

export async function handleFeishuReactionForTest(
  transport: FeishuMessageTransport,
  data: unknown,
): Promise<void> {
  await (transport as unknown as {
    handleReactionCreated(data: unknown): Promise<void>;
  }).handleReactionCreated(data);
}

export async function handleFeishuReceiveForTest(
  transport: FeishuMessageTransport,
  data: unknown,
): Promise<void> {
  await (transport as unknown as {
    handleReceiveMessage(data: unknown): Promise<void>;
  }).handleReceiveMessage(data);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function waitForRegistration(
  service: AgentFeishuService,
  registrationId: string,
  state: 'connected' | 'failed',
) {
  let last = await service.registrationStatus(registrationId);
  await waitFor(async () => {
    last = await service.registrationStatus(registrationId);
    return last.state === state;
  }, {
    description: `registration ${registrationId} to reach ${state}; last state ${last.state}`,
    intervalMs: 20,
    timeoutMs: 2_000,
  });
  return last;
}
