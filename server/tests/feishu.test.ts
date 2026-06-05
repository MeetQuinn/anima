import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  feishuReceiveMessageEventFromData,
  normalizeFeishuMessage,
  shouldWakeFeishuRuntime,
  type FeishuReceiveMessageEvent,
} from '../feishu/events.js';
import { createFeishuMessageClient, fetchFeishuTenantAccessToken } from '../feishu/client.js';
import { AgentFeishuService } from '../agents/agent-feishu.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { messageFromInboxItem } from '../messages/message.projection.js';
import { runFileSend } from '../tools/file-send.js';
import { runFileFetch } from '../tools/files-cli.js';
import { runMessageRead } from '../tools/message-read.js';
import { runMessageSend } from '../tools/messages.js';
import { withAnimaHome } from './anima-home.js';
import { allActivities, loadState } from './helpers/state.js';
import type {
  FeishuFileSendInput,
  FeishuFileUploadInput,
  FeishuMessageResourceDownloadInput,
  FeishuMessageListInput,
  FeishuTextSendInput,
} from '../feishu/client.js';
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

test('Feishu app registration stores returned app credentials without using scanner user as bot id', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-register-app-test-'));
  const homePath = join(stateDir, 'home');
  await mkdir(homePath, { recursive: true });
  try {
    await withAnimaHome(stateDir, async () => {
      await defaultAgentRegistryService.createAgent({
        homePath,
        name: 'Feishu Scout',
        provider: { kind: 'codex-cli', model: 'gpt-5.5' },
        role: 'Feishu registration test agent.',
      });

      let resolveRegister: ((result: { appId: string; appSecret: string; userOpenId: string }) => void) | undefined;
      const registerPromise = new Promise<{ appId: string; appSecret: string; userOpenId: string }>((resolve) => {
        resolveRegister = resolve;
      });
      let appPresetName: string | undefined;
      const service = new AgentFeishuService('feishu-scout', {
        async registerFeishuApp(input) {
          appPresetName = input.appPreset?.name;
          input.onQRCodeReady({ expireIn: 600, url: 'https://accounts.feishu.cn/verify?registration=test' });
          return registerPromise;
        },
      });

      const started = await service.startAppRegistration();
      assert.equal(started.state, 'waiting');
      assert.equal(started.verificationUrl, 'https://accounts.feishu.cn/verify?registration=test');
      assert.equal(started.expireIn, 600);
      assert.equal(appPresetName, 'Feishu Scout');

      resolveRegister?.({
        appId: 'cli_generated',
        appSecret: 'generated-secret',
        userOpenId: 'ou_scanning_user_not_bot',
      });

      const completed = await waitForRegistration(service, started.registrationId, 'connected');
      assert.equal(completed.agent?.feishu.connected, true);
      assert.equal(completed.agent?.feishu.appId, 'cli_generated');
      assert.equal(completed.agent?.feishu.botOpenId, undefined);

      const stored = await defaultAgentRegistryService.serviceFor('feishu-scout').getConfig();
      assert.equal(stored.feishu.appSecret, 'generated-secret');
      assert.equal(stored.feishu.botOpenId, undefined);
      assert.equal(stored.feishu.ownerOpenId, 'ou_scanning_user_not_bot');
      assert.match(stored.feishu.ownerGreetingPromptedAt ?? '', /^\d{4}-/);

      const items = await new WakeQueueService('feishu-scout').list();
      const onboarding = items.find((item) => item.kind === 'feishu_onboarding');
      assert.equal(onboarding?.kind, 'feishu_onboarding');
      assert.equal(onboarding?.kind === 'feishu_onboarding' ? onboarding.owner.openId : undefined, 'ou_scanning_user_not_bot');
      assert.equal(onboarding?.kind === 'feishu_onboarding' ? onboarding.target.receiveId : undefined, 'ou_scanning_user_not_bot');
      assert.equal(onboarding?.kind === 'feishu_onboarding' ? onboarding.target.receiveIdType : undefined, 'open_id');
      assert.match(onboarding?.kind === 'feishu_onboarding' ? onboarding.text : '', /Your owner is the person who connected you to Feishu/);
      assert.match(onboarding?.kind === 'feishu_onboarding' ? onboarding.text : '', /introduce yourself to your owner/);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('manual Feishu credentials path clears registerApp owner greeting metadata', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-manual-connect-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir, {
        ownerGreetingChatId: 'oc_owner_dm',
        ownerGreetingDeliveredAt: '2026-01-01T00:00:00.000Z',
        ownerGreetingMessageId: 'om_owner_hello',
        ownerGreetingPromptedAt: '2026-01-01T00:00:00.000Z',
        ownerOpenId: 'ou_register_owner',
        ownerTenantBrand: 'feishu',
      });

      const connected = await new AgentFeishuService('scout').connect({
        appId: 'manual-app',
        appSecret: 'manual-secret',
      });

      assert.equal(connected.feishu.appId, 'manual-app');
      assert.equal(connected.feishu.appSecret, 'manual-secret');
      assert.equal(connected.feishu.ownerOpenId, undefined);
      assert.equal(connected.feishu.ownerGreetingPromptedAt, undefined);
      assert.equal(connected.feishu.ownerGreetingChatId, undefined);
      assert.equal(connected.feishu.ownerGreetingMessageId, undefined);
      assert.equal(connected.feishu.ownerGreetingDeliveredAt, undefined);
      assert.deepEqual(await new WakeQueueService('scout').list(), []);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu app registration accepts an editable bot name override', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-register-app-name-test-'));
  const homePath = join(stateDir, 'home');
  await mkdir(homePath, { recursive: true });
  try {
    await withAnimaHome(stateDir, async () => {
      await defaultAgentRegistryService.createAgent({
        homePath,
        name: 'Feishu Scout',
        provider: { kind: 'codex-cli', model: 'gpt-5.5' },
        role: 'Feishu registration test agent.',
      });

      let appPresetName: string | undefined;
      const service = new AgentFeishuService('feishu-scout', {
        async registerFeishuApp(input) {
          appPresetName = input.appPreset?.name;
          input.onQRCodeReady({ expireIn: 600, url: 'https://accounts.feishu.cn/verify?registration=test' });
          return new Promise(() => undefined);
        },
      });

      const started = await service.startAppRegistration({ botName: 'Review Helper' });
      assert.equal(started.state, 'waiting');
      assert.equal(appPresetName, 'Review Helper');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu app registration falls back to the default preset when bot name is blank', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-register-app-blank-name-test-'));
  const homePath = join(stateDir, 'home');
  await mkdir(homePath, { recursive: true });
  try {
    await withAnimaHome(stateDir, async () => {
      await defaultAgentRegistryService.createAgent({
        homePath,
        name: 'Feishu Scout',
        provider: { kind: 'codex-cli', model: 'gpt-5.5' },
        role: 'Feishu registration test agent.',
      });

      let appPresetName: string | undefined;
      const service = new AgentFeishuService('feishu-scout', {
        async registerFeishuApp(input) {
          appPresetName = input.appPreset?.name;
          input.onQRCodeReady({ expireIn: 600, url: 'https://accounts.feishu.cn/verify?registration=test' });
          return new Promise(() => undefined);
        },
      });

      const started = await service.startAppRegistration({ botName: '   ' });
      assert.equal(started.state, 'waiting');
      assert.equal(appPresetName, 'Anima {user}');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
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

test('Feishu onboarding prompt targets the owner open_id without requiring an owner name', () => {
  const text = buildCodeAgentDeliveryPrompt({
    handling: {
      createdAt: '2026-01-01T00:00:00.000Z',
      queuedAt: '2026-01-01T00:00:00.000Z',
      status: 'queued',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    id: 'feishu-onboarding:scout:ou_owner',
    kind: 'feishu_onboarding',
    owner: {
      openId: 'ou_owner',
      tenantBrand: 'feishu',
    },
    receivedAt: '2026-01-01T00:00:00.000Z',
    target: {
      platform: 'feishu',
      receiveId: 'ou_owner',
      receiveIdType: 'open_id',
    },
    text: [
      "You've been set up here. Your owner is the person who connected you to Feishu.",
      'Start by reading your MEMORY.md — its Onboarding section walks you through getting set up — then reply here to introduce yourself to your owner.',
    ].join('\n\n'),
  });

  assert.match(text, /^Agent onboarding:/);
  assert.match(text, /\[owner=feishu-owner channel=ou_owner time=2026-01-01T00:00:00\.000Z\]/);
  assert.match(text, /Your owner is the person who connected you to Feishu/);
  assert.match(text, /Use `anima message send --channel ou_owner` to reply to your owner/);
  assert.doesNotMatch(text, /Slack|Lark|<@|ou_owner.*owner is/);
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

test('Feishu text sends can target a user open_id', async () => {
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
              return { data: { chat_id: 'oc_owner_dm', message_id: 'om_owner_hello' } };
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

  const result = await client.sendText({
    receiveId: 'ou_owner',
    receiveIdType: 'open_id',
    text: 'hello owner',
  });

  assert.deepEqual(capturedCreate, {
    data: {
      content: JSON.stringify({ text: 'hello owner' }),
      msg_type: 'text',
      receive_id: 'ou_owner',
    },
    params: {
      receive_id_type: 'open_id',
    },
  });
  assert.deepEqual(result, {
    chatId: 'oc_owner_dm',
    messageId: 'om_owner_hello',
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

test('Feishu message reads can list chat history', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedList: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() {
              throw new Error('unexpected create call');
            },
            async list(input) {
              capturedList = input;
              return {
                data: {
                  has_more: true,
                  items: [{
                    body: { content: JSON.stringify({ text: 'hello @_user_1' }) },
                    chat_id: 'oc_test_chat',
                    create_time: '1780410000000',
                    mentions: [{ id: 'ou_bob', id_type: 'open_id', key: '@_user_1', name: 'Bob' }],
                    message_id: 'om_test_message',
                    msg_type: 'text',
                    sender: {
                      id: 'ou_alice',
                      id_type: 'open_id',
                      sender_name: 'Alice',
                      sender_type: 'user',
                    },
                  }],
                  page_token: 'cursor-next',
                },
              };
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

  const result = await client.listMessages({ chatId: 'oc_test_chat', cursor: 'cursor-1', limit: 2 });

  assert.deepEqual(capturedList, {
    params: {
      container_id: 'oc_test_chat',
      container_id_type: 'chat',
      page_size: 2,
      page_token: 'cursor-1',
      sort_type: 'ByCreateTimeDesc',
    },
  });
  assert.deepEqual(result, {
    hasMore: true,
    messages: [{
      bodyContent: JSON.stringify({ text: 'hello @_user_1' }),
      chatId: 'oc_test_chat',
      createTime: '1780410000000',
      mentions: [{ id: 'ou_bob', idType: 'open_id', key: '@_user_1', name: 'Bob' }],
      messageId: 'om_test_message',
      messageType: 'text',
      sender: {
        id: 'ou_alice',
        idType: 'open_id',
        senderName: 'Alice',
        senderType: 'user',
      },
    }],
    nextCursor: 'cursor-next',
  });
});

test('message read can fetch Feishu chat history explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-message-read-test-'));
  const reads: FeishuMessageListInput[] = [];
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageRead(
        { agent: 'scout', channel: 'oc_target_chat', cursor: 'cursor-1', limit: 2 },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages(input) {
                reads.push(input);
                return {
                  hasMore: true,
                  messages: [{
                    bodyContent: JSON.stringify({ text: 'hello @_user_1' }),
                    chatId: 'oc_target_chat',
                    createTime: '1780410000000',
                    mentions: [{ key: '@_user_1', name: 'Bob' }],
                    messageId: 'om_test_message',
                    messageType: 'text',
                    sender: {
                      id: 'ou_alice',
                      idType: 'open_id',
                      senderName: 'Alice',
                      senderType: 'user',
                    },
                  }],
                  nextCursor: 'cursor-next',
                };
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );
    });

    assert.deepEqual(reads, [{ chatId: 'oc_target_chat', cursor: 'cursor-1', limit: 2 }]);
    const output = logLines.join('\n');
    assert.match(
      output,
      /\[platform=feishu chat_id=oc_target_chat message_id=om_test_message time=2026-06-02T14:20:00\.000Z user_id=ou_alice\] Alice: hello @Bob/,
    );
    assert.match(output, /\[page has_more=true next_cursor=cursor-next\]/);
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send can target a Feishu chat explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-explicit-chat-test-'));
  const sent: FeishuTextSendInput[] = [];
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
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText(input) {
                sent.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_sent' };
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );
    });

    assert.deepEqual(sent, [{
      receiveId: 'oc_target_chat',
      receiveIdType: 'chat_id',
      text: 'ordinary chat message',
    }]);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send can target a Feishu owner open_id and record greeting delivery', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-owner-send-test-'));
  const sent: FeishuTextSendInput[] = [];
  const previousItemId = process.env.ANIMA_INBOX_ITEM_ID;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir, {
        ownerGreetingPromptedAt: '2026-01-01T00:00:00.000Z',
        ownerOpenId: 'ou_owner',
      });
      const now = '2026-01-01T00:00:00.000Z';
      await new WakeQueueService('scout').enqueue({
        handling: { createdAt: now, queuedAt: now, status: 'queued', updatedAt: now },
        id: 'feishu-onboarding:scout:ou_owner',
        kind: 'feishu_onboarding',
        owner: { openId: 'ou_owner' },
        receivedAt: now,
        target: {
          platform: 'feishu',
          receiveId: 'ou_owner',
          receiveIdType: 'open_id',
        },
        text: 'Feishu owner greeting prompt',
      });
      process.env.ANIMA_INBOX_ITEM_ID = 'feishu-onboarding:scout:ou_owner';

      await runMessageSend(
        { agent: 'scout', channel: 'ou_owner', text: 'hello owner' },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText(input) {
                sent.push(input);
                return { chatId: 'oc_owner_dm', messageId: 'om_owner_hello' };
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );

      const stored = await defaultAgentRegistryService.serviceFor('scout').getConfig();
      assert.equal(stored.feishu.ownerGreetingChatId, 'oc_owner_dm');
      assert.equal(stored.feishu.ownerGreetingMessageId, 'om_owner_hello');
      assert.match(stored.feishu.ownerGreetingDeliveredAt ?? '', /^\d{4}-/);
    });

    assert.deepEqual(sent, [{
      receiveId: 'ou_owner',
      receiveIdType: 'open_id',
      text: 'hello owner',
    }]);
  } finally {
    if (previousItemId === undefined) {
      delete process.env.ANIMA_INBOX_ITEM_ID;
    } else {
      process.env.ANIMA_INBOX_ITEM_ID = previousItemId;
    }
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
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText(input) {
                replies.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_sent', threadId: 'omt_topic' };
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected ordinary send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
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

test('Feishu file uploads use image and file SDK endpoints', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedImage: unknown;
  let capturedFile: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          file: {
            async create(input) {
              capturedFile = input;
              return { data: { file_key: 'file_key_doc' } };
            },
          },
          image: {
            async create(input) {
              capturedImage = input;
              return { data: { image_key: 'image_key_photo' } };
            },
          },
          message: {
            async create() {
              throw new Error('unexpected create call');
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

  const image = await client.uploadFile({
    bytes: Buffer.from('fake-image'),
    filename: 'photo.png',
    mimetype: 'image/png',
  });
  const file = await client.uploadFile({
    bytes: Buffer.from('fake-pdf'),
    filename: 'report.pdf',
    mimetype: 'application/pdf',
  });

  assert.deepEqual(image, { fileKey: 'image_key_photo', kind: 'image' });
  assert.deepEqual(file, { fileKey: 'file_key_doc', kind: 'file' });
  assert.deepEqual(capturedImage, {
    data: {
      image: Buffer.from('fake-image'),
      image_type: 'message',
    },
  });
  assert.deepEqual(capturedFile, {
    data: {
      file: Buffer.from('fake-pdf'),
      file_name: 'report.pdf',
      file_type: 'pdf',
    },
  });
});

test('Feishu uploaded files can be sent to chats and topics', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  const creates: unknown[] = [];
  const replies: unknown[] = [];

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create(input) {
              creates.push(input);
              return { data: { chat_id: 'oc_test_chat', message_id: 'om_file' } };
            },
            async reply(input) {
              replies.push(input);
              return { data: { chat_id: 'oc_test_chat', message_id: 'om_image', thread_id: 'omt_topic' } };
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

  const fileResult = await client.sendUploadedFile({
    file: { fileKey: 'file_key_report', kind: 'file' },
    receiveId: 'oc_test_chat',
    receiveIdType: 'chat_id',
  });
  const imageResult = await client.sendUploadedFile({
    file: { fileKey: 'image_key_photo', kind: 'image' },
    receiveId: 'oc_test_chat',
    receiveIdType: 'chat_id',
    threadMessageId: 'om_topic_root',
  });

  assert.deepEqual(creates, [{
    data: {
      content: JSON.stringify({ file_key: 'file_key_report' }),
      msg_type: 'file',
      receive_id: 'oc_test_chat',
    },
    params: {
      receive_id_type: 'chat_id',
    },
  }]);
  assert.deepEqual(replies, [{
    data: {
      content: JSON.stringify({ image_key: 'image_key_photo' }),
      msg_type: 'image',
      reply_in_thread: true,
    },
    path: {
      message_id: 'om_topic_root',
    },
  }]);
  assert.deepEqual(fileResult, { chatId: 'oc_test_chat', messageId: 'om_file' });
  assert.deepEqual(imageResult, { chatId: 'oc_test_chat', messageId: 'om_image', threadId: 'omt_topic' });
});

test('file send can upload to a Feishu chat explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-file-send-test-'));
  const logLines: string[] = [];
  const order: string[] = [];
  const uploads: FeishuFileUploadInput[] = [];
  const fileSends: FeishuFileSendInput[] = [];
  const captions: FeishuTextSendInput[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      const localPath = join(stateDir, 'evidence.png');
      await writeFile(localPath, Buffer.from('fake-png-bytes'));

      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runFileSend(
        {
          agent: 'scout',
          caption: 'see attached',
          channel: 'oc_target_chat',
          paths: [localPath],
        },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async sendUploadedFile(input) {
                order.push('send-file');
                fileSends.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_file' };
              },
              async sendText(input) {
                order.push('caption');
                captions.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_caption' };
              },
              async uploadFile(input) {
                order.push('upload');
                uploads.push(input);
                return { fileKey: 'image_key_evidence', kind: 'image' };
              },
            };
          },
        },
      );

      const completed = allActivities(await loadState()).at(-1);
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'feishu.file.send');
      assert.equal(completed?.payload?.['tool'], 'anima.file.send');
      assert.equal(completed?.payload?.['platform'], 'feishu');
      assert.equal(completed?.payload?.['receiveId'], 'oc_target_chat');
      assert.equal(completed?.payload?.['receiveIdType'], 'chat_id');
      assert.equal(completed?.payload?.['fileCount'], 1);
      assert.equal(completed?.payload?.['caption'], 'see attached');
      assert.equal(completed?.payload?.['captionMessageId'], 'om_caption');
      const completedUploads = completed?.payload?.['uploads'] as Array<Record<string, unknown>>;
      assert.equal(completedUploads.length, 1);
      assert.equal(completedUploads[0]?.['fileId'], 'image_key_evidence');
      assert.equal(completedUploads[0]?.['kind'], 'image');
      assert.equal(completedUploads[0]?.['messageId'], 'om_file');
      assert.equal(completedUploads[0]?.['mimetype'], 'image/png');
    });

    assert.deepEqual(order, ['upload', 'send-file', 'caption']);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]?.filename, 'evidence.png');
    assert.equal(uploads[0]?.mimetype, 'image/png');
    assert.equal(uploads[0]?.bytes.toString(), 'fake-png-bytes');
    assert.deepEqual(fileSends, [{
      file: { fileKey: 'image_key_evidence', kind: 'image' },
      receiveId: 'oc_target_chat',
      receiveIdType: 'chat_id',
    }]);
    assert.deepEqual(captions, [{
      receiveId: 'oc_target_chat',
      receiveIdType: 'chat_id',
      text: 'see attached',
    }]);
    assert.match(logLines.join('\n'), /uploaded successfully\. feishu chat_id=oc_target_chat, files=1\./);
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu message resources can be downloaded from the SDK stream', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedGet: unknown;

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() {
              throw new Error('unexpected create call');
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
          messageResource: {
            async get(input) {
              capturedGet = input;
              return {
                getReadableStream() {
                  return Readable.from([Buffer.from('downloaded-image')]);
                },
                headers: {
                  'Content-Disposition': 'attachment; filename="photo.png"',
                  'Content-Type': 'image/png',
                },
              };
            },
          },
        },
      };
    },
  });

  const downloaded = await client.downloadMessageResource({
    fileKey: 'image_key_photo',
    messageId: 'om_photo',
    resourceType: 'image',
  });

  assert.deepEqual(capturedGet, {
    params: {
      type: 'image',
    },
    path: {
      file_key: 'image_key_photo',
      message_id: 'om_photo',
    },
  });
  assert.equal(downloaded.bytes.toString(), 'downloaded-image');
  assert.equal(downloaded.contentType, 'image/png');
  assert.equal(downloaded.filename, 'photo.png');
});

test('message read emits Feishu file resource ids for fetch', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-message-read-files-test-'));
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageRead(
        { agent: 'scout', channel: 'oc_target_chat', limit: 2 },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async listMessages() {
                return {
                  hasMore: false,
                  messages: [{
                    bodyContent: JSON.stringify({ file_key: 'file_key_report', file_name: 'report.pdf', file_size: '42' }),
                    chatId: 'oc_target_chat',
                    createTime: '1780410000000',
                    messageId: 'om_file_message',
                    messageType: 'file',
                    sender: {
                      id: 'ou_alice',
                      senderName: 'Alice',
                      senderType: 'user',
                    },
                  }, {
                    bodyContent: JSON.stringify({ image_key: 'image_key_photo' }),
                    chatId: 'oc_target_chat',
                    createTime: '1780410001000',
                    messageId: 'om_image_message',
                    messageType: 'image',
                    sender: {
                      id: 'ou_bob',
                      senderName: 'Bob',
                      senderType: 'user',
                    },
                  }],
                };
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );
    });

    const output = logLines.join('\n');
    assert.match(output, /attached: id=feishu:message:om_file_message:file:file_key_report name=report\.pdf size_bytes=42/);
    assert.match(output, /use `anima file fetch feishu:message:om_file_message:file:file_key_report` to download/);
    assert.match(output, /attached: id=feishu:message:om_image_message:image:image_key_photo/);
    assert.match(output, /use `anima file fetch feishu:message:om_image_message:image:image_key_photo` to download/);
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('file fetch can download a Feishu message resource id', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-file-fetch-test-'));
  const logLines: string[] = [];
  const downloads: FeishuMessageResourceDownloadInput[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runFileFetch(
        {
          agent: 'scout',
          file: 'feishu:message:om_file_message:file:file_key_report',
        },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource(input) {
                downloads.push(input);
                return {
                  bytes: Buffer.from('downloaded-report'),
                  contentType: 'application/pdf',
                  filename: 'report.pdf',
                };
              },
              async listMessages() {
                throw new Error('unexpected message read');
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );

      const firstPath = logLines.at(-1);
      assert.ok(firstPath);
      assert.equal(await readFile(firstPath, 'utf8'), 'downloaded-report');

      await runFileFetch(
        {
          agent: 'scout',
          file: 'feishu:message:om_file_message:file:file_key_report',
        },
        {
          createFeishuMessageClient() {
            throw new Error('cached Feishu fetch should not call the API again');
          },
        },
      );
      assert.equal(logLines.at(-1), firstPath);
    });

    assert.deepEqual(downloads, [{
      fileKey: 'file_key_report',
      messageId: 'om_file_message',
      resourceType: 'file',
    }]);
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function writeFeishuConfig(configDir: string, feishu: Partial<FeishuConfig> = {}): Promise<void> {
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
        ...feishu,
      },
      homePath,
      id: 'scout',
      provider: { kind: 'codex-cli', model: 'gpt-5.5' },
    }, null, 2)}\n`,
    'utf8',
  );
}

async function waitForRegistration(
  service: AgentFeishuService,
  registrationId: string,
  state: 'connected' | 'failed',
) {
  const deadline = Date.now() + 2_000;
  let last = await service.registrationStatus(registrationId);
  while (Date.now() < deadline) {
    last = await service.registrationStatus(registrationId);
    if (last.state === state) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for registration ${registrationId} to reach ${state}; last state ${last.state}`);
}
