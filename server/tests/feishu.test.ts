import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  feishuReceiveMessageEventFromData,
  normalizeFeishuMessage,
  shouldWakeFeishuRuntime,
  type FeishuReceiveMessageEvent,
} from '../feishu/events.js';
import { createFeishuMessageClient, fetchFeishuTenantAccessToken } from '../feishu/client.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { messageFromInboxItem } from '../messages/message.projection.js';
import { runMessageSend } from '../tools/messages.js';
import { withAnimaHome } from './anima-home.js';
import type { FeishuConfig } from '../../shared/agent-config.js';

function makeFeishuEvent(overrides: Omit<Partial<FeishuReceiveMessageEvent>, 'message' | 'sender'> & {
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

test('normalizes Feishu text DMs into inbox items', () => {
  const item = normalizeFeishuMessage({ event: makeFeishuEvent() });

  assert.equal(item?.kind, 'feishu');
  assert.equal(item?.id, 'feishu:tenant_test:oc_test_chat:om_test_message');
  assert.equal(item?.chatId, 'oc_test_chat');
  assert.equal(item?.chatType, 'p2p');
  assert.equal(item?.messageId, 'om_test_message');
  assert.equal(item?.receivedAt, '2026-06-02T14:20:00.000Z');
  assert.equal(item?.actor?.openId, 'ou_alice');
  assert.equal(item?.text, 'hello from Feishu');
});

test('Feishu group wake policy requires the configured bot mention', () => {
  const event = makeFeishuEvent({
    message: {
      chat_type: 'group',
      mentions: [{
        id: { open_id: 'ou_other_bot' },
        key: '@_user_1',
        mentioned_type: 'app',
        name: 'OtherBot',
      }],
    },
  });

  assert.equal(shouldWakeFeishuRuntime(event, 'ou_anima_bot'), false);

  event.message.mentions = [{
    id: { open_id: 'ou_anima_bot' },
    key: '@_user_1',
    mentioned_type: 'app',
    name: 'Anima',
  }];
  assert.equal(shouldWakeFeishuRuntime(event, 'ou_anima_bot'), true);
});

test('normalizes Feishu mention keys to readable labels', () => {
  const item = normalizeFeishuMessage({
    botOpenId: 'ou_anima_bot',
    event: makeFeishuEvent({
      message: {
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 please check' }),
        mentions: [{
          id: { open_id: 'ou_anima_bot' },
          key: '@_user_1',
          mentioned_type: 'app',
          name: 'Anima',
        }],
      },
    }),
  });

  assert.equal(item?.text, '@Anima please check');
});

test('accepts SDK direct events and wrapped raw Feishu events', () => {
  const event = makeFeishuEvent();

  assert.equal(feishuReceiveMessageEventFromData(event)?.message.message_id, 'om_test_message');
  assert.equal(feishuReceiveMessageEventFromData({ event })?.message.message_id, 'om_test_message');
  assert.equal(feishuReceiveMessageEventFromData({ event: { message: null } }), undefined);
});

test('Feishu delivery prompt is platform-aware', () => {
  const item = normalizeFeishuMessage({ event: makeFeishuEvent() });
  assert.ok(item);

  assert.equal(
    buildCodeAgentDeliveryPrompt(item),
    [
      'New Feishu message:\n\n[platform=feishu chat=p2p chat_id=oc_test_chat message_id=om_test_message time=2026-06-02T14:20:00.000Z user_id=ou_alice] ou_alice: hello from Feishu',
      [
        'Reply target:',
        'Use `anima message send --channel oc_test_chat` to post back to this Feishu chat.',
        'Use `anima message send --channel oc_test_chat --thread-ts om_test_message` to reply in this message\'s topic.',
        'Use `anima message send --channel <chat_id>` to send to an explicit Feishu chat.',
        'Feishu API access: use `FEISHU_TENANT_ACCESS_TOKEN`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_API_BASE_URL` from env when you need Feishu APIs. Do not print these values.',
      ].join('\n'),
    ].join('\n\n'),
  );
});

test('mints Feishu tenant access token from app credentials', async () => {
  const result = await fetchFeishuTenantAccessToken({
    appId: 'cli_test',
    appSecret: 'feishu-secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  }, {
    apiBaseUrl: 'https://feishu.example/open-apis/',
    async fetch(url, init) {
      assert.equal(url, 'https://feishu.example/open-apis/auth/v3/tenant_access_token/internal');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), {
        app_id: 'cli_test',
        app_secret: 'feishu-secret',
      });
      return {
        async json() {
          return {
            code: 0,
            expire: 7200,
            tenant_access_token: 't-tenant',
          };
        },
        ok: true,
        status: 200,
        async text() {
          return '';
        },
      };
    },
    nowMs: () => Date.parse('2026-06-03T00:00:00.000Z'),
  });

  assert.deepEqual(result, {
    expiresAt: '2026-06-03T02:00:00.000Z',
    tenantAccessToken: 't-tenant',
  });
});

test('Feishu inbox messages project into the message ledger', () => {
  const item = normalizeFeishuMessage({ event: makeFeishuEvent() });
  assert.ok(item);

  const message = messageFromInboxItem(item);
  assert.equal(message?.platform, 'feishu');
  assert.equal(message?.actor, 'ou_alice');
  assert.equal(message?.channelId, 'oc_test_chat');
  assert.equal(message?.channelDisplayName, 'Feishu DM');
  assert.equal(message?.messageTs, 'om_test_message');
});

test('Feishu text sends can post ordinary chat messages', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedCreate: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create(input) {
              capturedCreate = input;
              return { data: { chat_id: 'oc_test_chat', message_id: 'om_reply' } };
            },
            async reply() {
              throw new Error('unexpected reply call');
            },
          },
          messageReaction: {
            async create() {
              throw new Error('unexpected reaction create call');
            },
            async delete() {
              throw new Error('unexpected reaction delete call');
            },
          },
        },
      };
    },
  });

  const result = await client.sendText({ chatId: 'oc_test_chat', text: 'hello reply' });

  assert.deepEqual(capturedCreate, {
    data: {
      content: JSON.stringify({ text: 'hello reply' }),
      msg_type: 'text',
      receive_id: 'oc_test_chat',
    },
    params: {
      receive_id_type: 'chat_id',
    },
  });
  assert.deepEqual(result, {
    chatId: 'oc_test_chat',
    messageId: 'om_reply',
  });
});

test('Feishu text replies can post in a message topic', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedReply: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() {
              throw new Error('unexpected create call');
            },
            async reply(input) {
              capturedReply = input;
              return { data: { chat_id: 'oc_test_chat', message_id: 'om_reply', thread_id: 'omt_topic' } };
            },
          },
          messageReaction: {
            async create() {
              throw new Error('unexpected reaction create call');
            },
            async delete() {
              throw new Error('unexpected reaction delete call');
            },
          },
        },
      };
    },
  });

  const result = await client.replyText({
    messageId: 'om_test_message',
    replyInThread: true,
    text: 'topic reply',
  });

  assert.deepEqual(capturedReply, {
    data: {
      content: JSON.stringify({ text: 'topic reply' }),
      msg_type: 'text',
      reply_in_thread: true,
    },
    path: {
      message_id: 'om_test_message',
    },
  });
  assert.deepEqual(result, {
    chatId: 'oc_test_chat',
    messageId: 'om_reply',
    threadId: 'omt_topic',
  });
});

test('message send can target a Feishu chat explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-explicit-chat-test-'));
  const sent: Array<{ chatId: string; text: string }> = [];
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      await runMessageSend(
        { agent: 'scout', channel: 'oc_target_chat', text: 'ordinary chat message' },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async sendText(input) {
                sent.push(input);
                return { chatId: input.chatId, messageId: 'om_sent' };
              },
            };
          },
        },
      );
    });

    assert.deepEqual(sent, [{ chatId: 'oc_target_chat', text: 'ordinary chat message' }]);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send can target a Feishu topic explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-explicit-topic-test-'));
  const replies: Array<{ messageId: string; replyInThread: boolean; text: string }> = [];
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      await runMessageSend(
        { agent: 'scout', channel: 'oc_target_chat', text: 'topic message', threadTs: 'om_topic_root' },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText(input) {
                replies.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_sent', threadId: 'omt_topic' };
              },
              async sendText() {
                throw new Error('unexpected ordinary send');
              },
            };
          },
        },
      );
    });

    assert.deepEqual(replies, [{ messageId: 'om_topic_root', replyInThread: true, text: 'topic message' }]);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function writeFeishuConfig(configDir: string): Promise<void> {
  const agentDir = join(configDir, 'agents', 'scout');
  const homePath = join(configDir, 'home');
  await mkdir(agentDir, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`, 'utf8');
  await writeFile(
    join(agentDir, 'config.json'),
    `${JSON.stringify({
      feishu: {
        appId: 'cli_test',
        appSecret: 'secret',
      },
      homePath,
      id: 'scout',
      provider: { kind: 'codex-cli', model: 'gpt-5.5' },
    }, null, 2)}\n`,
    'utf8',
  );
}
