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
import {
  createFeishuMessageClient,
  fetchFeishuAppScopes,
  fetchFeishuBotInfo,
  fetchFeishuTenantAccessToken,
} from '../feishu/client.js';
import { FeishuDirectoryService } from '../feishu/directory.service.js';
import { AgentFeishuService } from '../agents/agent-feishu.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { messageFromInboxItem } from '../messages/message.projection.js';
import { runFileSend } from '../tools/file-send.js';
import { runFileFetch } from '../tools/files-cli.js';
import { runMessageRead } from '../tools/message-read.js';
import { runMessageReact } from '../tools/reactions.js';
import { runMessageSend, runMessageUpdate } from '../tools/messages.js';
import { withAnimaHome } from './anima-home.js';
import { allActivities, loadState } from './helpers/state.js';
import type {
  FeishuFileSendInput,
  FeishuFileUploadInput,
  FeishuMessageResourceDownloadInput,
  FeishuMessageListInput,
  FeishuMessageClient,
  FeishuPostSendInput,
  FeishuPostUpdateInput,
  FeishuReactionAddInput,
  FeishuReactionRemoveInput,
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

function testFeishuMessageClient(overrides: Partial<FeishuMessageClient> = {}): FeishuMessageClient {
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

function jsonResponse(payload: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    json: async () => payload,
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
  } as Response;
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

test('normalizes Feishu file messages into prompt attachments', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({
          file_key: 'file_key_report',
          file_name: 'report.pdf',
          file_size: '42',
        }),
        message_id: 'om_file_message',
        message_type: 'file',
      },
    }),
  });

  assert.ok(item);
  assert.equal(item.text, '[file] report.pdf');
  assert.deepEqual(item.files, [{
    id: 'feishu:message:om_file_message:file:file_key_report',
    mimetype: 'application/octet-stream',
    name: 'report.pdf',
    sizeBytes: 42,
  }]);

  const prompt = buildCodeAgentDeliveryPrompt(item);
  assert.match(prompt, /^New Feishu message:/);
  assert.match(prompt, /ou_alice: \[file\] report\.pdf/);
  assert.match(prompt, /<attached_files>/);
  assert.match(prompt, /<file id="feishu:message:om_file_message:file:file_key_report" name="report\.pdf" mimetype="application\/octet-stream" size_bytes="42" \/>/);
  assert.doesNotMatch(prompt, /Reply target:|Feishu API access:/);

  const message = messageFromInboxItem(item);
  assert.deepEqual(message?.files, [{
    filename: 'report.pdf',
    fileId: 'feishu:message:om_file_message:file:file_key_report',
    mimetype: 'application/octet-stream',
    sizeBytes: 42,
  }]);
});

test('Feishu delivery prompt includes attention suggestions', () => {
  const item = normalizeFeishuMessage({ event: makeFeishuEvent() });
  assert.ok(item);
  const prompt = buildCodeAgentDeliveryPrompt({
    ...item,
    attentionSuggestion: 'Mute with `anima subscription mute --chat-id oc_test_chat`.',
  });

  assert.match(prompt, /Attention suggestion:\nMute with `anima subscription mute --chat-id oc_test_chat`\./);
});

test('normalizes Feishu image messages into fetchable prompt attachments', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({ image_key: 'image_key_photo' }),
        message_id: 'om_image_message',
        message_type: 'image',
      },
    }),
  });

  assert.ok(item);
  assert.equal(item.text, '[image] image-om_image_message');
  assert.deepEqual(item.files, [{
    id: 'feishu:message:om_image_message:image:image_key_photo',
    mimetype: 'image/*',
    name: 'image-om_image_message',
    sizeBytes: 0,
  }]);

  const prompt = buildCodeAgentDeliveryPrompt(item);
  assert.match(prompt, /<file id="feishu:message:om_image_message:image:image_key_photo" name="image-om_image_message" mimetype="image\/\*" size_bytes="0" \/>/);
});

test('ignores unsupported Feishu non-text messages without fetchable resources', () => {
  const item = normalizeFeishuMessage({
    event: makeFeishuEvent({
      message: {
        content: JSON.stringify({ sticker_key: 'sticker_1' }),
        message_id: 'om_sticker_message',
        message_type: 'sticker',
      },
    }),
  });

  assert.equal(item, undefined);
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

test('normalizes Feishu group messages even when they are not direct mentions', () => {
  const item = normalizeFeishuMessage({
    botOpenId: 'ou_anima_bot',
    event: makeFeishuEvent({
      message: {
        chat_type: 'group',
        content: JSON.stringify({ text: 'background group message' }),
        mentions: [],
      },
    }),
  });

  assert.equal(item?.kind, 'feishu');
  assert.equal(item?.chatType, 'group');
  assert.equal(item?.text, 'background group message');
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
    'New Feishu message:\n\n[platform=feishu chat=p2p chat_id=oc_test_chat message_id=om_test_message time=2026-06-02T14:20:00.000Z user_id=ou_alice] ou_alice: hello from Feishu',
  );
});

test('Feishu directory enriches live delivery prompt with actor and chat names', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-directory-prompt-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const receiveEvent = makeFeishuEvent({
        message: {
          chat_type: 'group',
          mentions: [{
            id: { open_id: 'ou_bob' },
            key: '@_user_1',
            mentioned_type: 'user',
            name: 'Bob',
          }],
        },
      });
      const item = normalizeFeishuMessage({ event: receiveEvent });
      assert.ok(item);

      const service = new FeishuDirectoryService({
        directoryId: 'tenant_test',
        now: () => '2026-06-07T00:00:00.000Z',
      });
      const enriched = await service.enrichInboxItem({
        client: testFeishuMessageClient({
          async getChat(input) {
            assert.deepEqual(input, { chatId: 'oc_test_chat' });
            return { chatId: 'oc_test_chat', chatName: '产品群', chatType: 'group' };
          },
          async getMessage(input) {
            assert.deepEqual(input, { messageId: 'om_test_message' });
            return {
              chatId: 'oc_test_chat',
              messageId: 'om_test_message',
              sender: {
                id: 'ou_alice',
                idType: 'open_id',
                senderName: 'Alice',
                senderType: 'user',
              },
            };
          },
        }),
        item,
        receiveEvent,
      });

      assert.equal(enriched.actor?.displayName, 'Alice');
      assert.equal(enriched.chatName, '产品群');
      assert.equal((await service.getCachedUser('ou_bob'))?.displayName, 'Bob');
      assert.equal((await service.getCachedChat('oc_test_chat'))?.chatName, '产品群');
      assert.equal(
        buildCodeAgentDeliveryPrompt(enriched),
        'New Feishu message:\n\n[platform=feishu chat=group chat_id=oc_test_chat chat_name="产品群" message_id=om_test_message time=2026-06-02T14:20:00.000Z user_id=ou_alice] Alice: hello from Feishu',
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
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

test('Feishu bot info fetch reads display info', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  const calls: Array<{ data?: unknown; method: 'GET' | 'POST'; url: string }> = [];
  const info = await fetchFeishuBotInfo(config, {
    createClient() {
      return {
        async request(input) {
          calls.push(input);
          return {
            bot: {
              app_name: 'Feishu Scout',
              avatar_url: 'https://example.test/feishu-scout.png',
              open_id: 'ou_bot',
            },
            code: 0,
            msg: 'ok',
          };
        },
        im: {
          message: {
            async create() { throw new Error('not used'); },
            async reply() { throw new Error('not used'); },
          },
          messageReaction: {
            async create() { throw new Error('not used'); },
            async delete() { throw new Error('not used'); },
          },
        },
      };
    },
  });

  assert.deepEqual(calls, [{ method: 'GET', url: '/open-apis/bot/v3/info' }]);
  assert.deepEqual(info, {
    appName: 'Feishu Scout',
    avatarUrl: 'https://example.test/feishu-scout.png',
    openId: 'ou_bot',
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
      let appPresetDescription: string | undefined;
      const service = new AgentFeishuService('feishu-scout', {
        async getFeishuBotInfo(config) {
          assert.equal(config.appId, 'cli_generated');
          return {
            avatarUrl: 'https://example.test/feishu-bot.png',
            openId: 'ou_actual_bot',
          };
        },
        async registerFeishuApp(input) {
          appPresetName = input.appPreset?.name;
          appPresetDescription = input.appPreset?.desc;
          input.onQRCodeReady({ expireIn: 600, url: 'https://accounts.feishu.cn/verify?registration=test' });
          return registerPromise;
        },
      });

      const started = await service.startAppRegistration();
      assert.equal(started.state, 'waiting');
      assert.equal(started.verificationUrl, 'https://accounts.feishu.cn/verify?registration=test');
      assert.equal(started.expireIn, 600);
      assert.equal(appPresetName, 'Feishu Scout');
      assert.equal(appPresetDescription, 'Feishu registration test agent.');

      resolveRegister?.({
        appId: 'cli_generated',
        appSecret: 'generated-secret',
        userOpenId: 'ou_scanning_user_not_bot',
      });

      const completed = await waitForRegistration(service, started.registrationId, 'connected');
      assert.equal(completed.agent?.feishu.connected, true);
      assert.equal(completed.agent?.feishu.appId, 'cli_generated');
      assert.equal(completed.agent?.feishu.avatarUrl, 'https://example.test/feishu-bot.png');
      assert.equal(completed.agent?.feishu.botOpenId, 'ou_actual_bot');

      const stored = await defaultAgentRegistryService.serviceFor('feishu-scout').getConfig();
      assert.equal(stored.feishu.appSecret, 'generated-secret');
      assert.equal(stored.feishu.avatarUrl, 'https://example.test/feishu-bot.png');
      assert.equal(stored.feishu.botOpenId, 'ou_actual_bot');
      assert.equal(stored.feishu.ownerOpenId, 'ou_scanning_user_not_bot');
      assert.notEqual(stored.feishu.botOpenId, stored.feishu.ownerOpenId);
      assert.match(stored.feishu.botProfileSyncedAt ?? '', /^\d{4}-/);
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

      const connected = await new AgentFeishuService('scout', {
        async getFeishuBotInfo(config) {
          assert.equal(config.appId, 'manual-app');
          return {
            avatarUrl: 'https://example.test/manual-feishu-bot.png',
            openId: 'ou_manual_bot',
          };
        },
      }).connect({
        appId: 'manual-app',
        appSecret: 'manual-secret',
      });

      assert.equal(connected.feishu.appId, 'manual-app');
      assert.equal(connected.feishu.appSecret, 'manual-secret');
      assert.equal(connected.feishu.avatarUrl, 'https://example.test/manual-feishu-bot.png');
      assert.equal(connected.feishu.botOpenId, 'ou_manual_bot');
      assert.match(connected.feishu.botProfileSyncedAt ?? '', /^\d{4}-/);
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

test('manual Feishu credentials supersede an active registerApp session', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-manual-supersede-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);

      let resolveRegister: ((result: { appId: string; appSecret: string; userOpenId: string }) => void) | undefined;
      const registerPromise = new Promise<{ appId: string; appSecret: string; userOpenId: string }>((resolve) => {
        resolveRegister = resolve;
      });
      const service = new AgentFeishuService('scout', {
        async getFeishuBotInfo(config) {
          assert.equal(config.appId, 'manual-app');
          return {
            avatarUrl: 'https://example.test/manual-feishu-bot.png',
            openId: 'ou_manual_bot',
          };
        },
        async registerFeishuApp(input) {
          input.onQRCodeReady({ expireIn: 600, url: 'https://accounts.feishu.cn/verify?registration=supersede' });
          return registerPromise;
        },
      });

      const started = await service.startAppRegistration({ botName: 'Scout' });
      assert.equal(started.state, 'waiting');
      assert.equal(started.verificationUrl, 'https://accounts.feishu.cn/verify?registration=supersede');

      const manual = await service.connect({
        appId: 'manual-app',
        appSecret: 'manual-secret',
      });
      assert.equal(manual.feishu.appId, 'manual-app');
      assert.equal(manual.feishu.appSecret, 'manual-secret');
      assert.equal(manual.feishu.botOpenId, 'ou_manual_bot');
      assert.equal(manual.feishu.ownerOpenId, undefined);
      assert.equal(manual.feishu.ownerGreetingPromptedAt, undefined);

      const aborted = await service.registrationStatus(started.registrationId);
      assert.equal(aborted.state, 'failed');
      assert.equal(aborted.error?.code, 'abort');

      resolveRegister?.({
        appId: 'cli_generated_late',
        appSecret: 'generated-secret-late',
        userOpenId: 'ou_late_owner',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const stored = await defaultAgentRegistryService.serviceFor('scout').getConfig();
      assert.equal(stored.feishu.appId, 'manual-app');
      assert.equal(stored.feishu.appSecret, 'manual-secret');
      assert.equal(stored.feishu.botOpenId, 'ou_manual_bot');
      assert.equal(stored.feishu.ownerOpenId, undefined);
      assert.equal(stored.feishu.ownerGreetingPromptedAt, undefined);
      assert.deepEqual(await new WakeQueueService('scout').list(), []);

      const stillAborted = await service.registrationStatus(started.registrationId);
      assert.equal(stillAborted.state, 'failed');
      assert.equal(stillAborted.agent, undefined);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu display-info sync refreshes once then throttles within the TTL', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-sync-throttle-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);

      let calls = 0;
      const service = new AgentFeishuService('scout', {
        async getFeishuBotInfo() {
          calls += 1;
          return {
            avatarUrl: `https://example.test/feishu-${calls}.png`,
            openId: 'ou_synced_bot',
          };
        },
      });
      const sixHoursMs = 6 * 60 * 60 * 1000;

      const first = await service.syncDisplayInfoIfStale({ ttlMs: sixHoursMs });
      assert.equal(first.synced, true);
      assert.equal(calls, 1);
      const stamped = await defaultAgentRegistryService.serviceFor('scout').getConfig();
      assert.equal(stamped.feishu.avatarUrl, 'https://example.test/feishu-1.png');
      assert.equal(stamped.feishu.botOpenId, 'ou_synced_bot');
      assert.ok(stamped.feishu.botProfileSyncedAt, 'botProfileSyncedAt should be set after a sync');

      const second = await service.syncDisplayInfoIfStale({ ttlMs: sixHoursMs });
      assert.equal(second.synced, false);
      assert.equal(calls, 1, 'throttled call must not hit Feishu again');

      const forced = await service.syncDisplayInfoIfStale({ ttlMs: 0 });
      assert.equal(forced.synced, true);
      assert.equal(calls, 2);
      const refreshed = await defaultAgentRegistryService.serviceFor('scout').getConfig();
      assert.equal(refreshed.feishu.avatarUrl, 'https://example.test/feishu-2.png');
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
      let appPresetDescription: string | undefined;
      const service = new AgentFeishuService('feishu-scout', {
        async registerFeishuApp(input) {
          appPresetName = input.appPreset?.name;
          appPresetDescription = input.appPreset?.desc;
          input.onQRCodeReady({ expireIn: 600, url: 'https://accounts.feishu.cn/verify?registration=test' });
          return new Promise(() => undefined);
        },
      });

      const started = await service.startAppRegistration({ botName: 'Review Helper' });
      assert.equal(started.state, 'waiting');
      assert.equal(appPresetName, 'Review Helper');
      assert.equal(appPresetDescription, 'Feishu registration test agent.');
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
      let appPresetDescription: string | undefined;
      const service = new AgentFeishuService('feishu-scout', {
        async registerFeishuApp(input) {
          appPresetName = input.appPreset?.name;
          appPresetDescription = input.appPreset?.desc;
          input.onQRCodeReady({ expireIn: 600, url: 'https://accounts.feishu.cn/verify?registration=test' });
          return new Promise(() => undefined);
        },
      });

      const started = await service.startAppRegistration({ botName: '   ' });
      assert.equal(started.state, 'waiting');
      assert.equal(appPresetName, 'Anima {user}');
      assert.equal(appPresetDescription, 'Feishu registration test agent.');
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
  assert.match(text, /\[platform=feishu owner=feishu-owner channel=ou_owner receive_id_type=open_id time=2026-01-01T00:00:00\.000Z\]/);
  assert.match(text, /Your owner is the person who connected you to Feishu/);
  assert.doesNotMatch(text, /Reply target:|Use `anima message send/);
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

test('Feishu message reads can list topic history', async () => {
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
                  has_more: false,
                  items: [{
                    body: { content: JSON.stringify({ text: 'topic reply' }) },
                    chat_id: 'oc_test_chat',
                    create_time: '1780410000000',
                    message_id: 'om_topic_reply',
                    msg_type: 'text',
                    parent_id: 'om_topic_root',
                    root_id: 'om_topic_root',
                    thread_id: 'omt_topic',
                  }],
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

  const result = await client.listMessages({
    chatId: 'oc_test_chat',
    cursor: 'cursor-1',
    limit: 2,
    threadId: 'omt_topic',
  });

  assert.deepEqual(capturedList, {
    params: {
      container_id: 'omt_topic',
      container_id_type: 'thread',
      page_size: 2,
      page_token: 'cursor-1',
      sort_type: 'ByCreateTimeDesc',
    },
  });
  assert.deepEqual(result.messages, [{
    bodyContent: JSON.stringify({ text: 'topic reply' }),
    chatId: 'oc_test_chat',
    createTime: '1780410000000',
    messageId: 'om_topic_reply',
    messageType: 'text',
    parentId: 'om_topic_root',
    rootId: 'om_topic_root',
    threadId: 'omt_topic',
  }]);
});

test('Feishu messages can resolve a topic root message to a thread id', async () => {
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
            async get(input) {
              capturedGet = input;
              return {
                data: {
                  items: [{
                    chat_id: 'oc_test_chat',
                    message_id: 'om_topic_root',
                    msg_type: 'text',
                    thread_id: 'omt_topic',
                  }],
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

  const message = await client.getMessage?.({ messageId: 'om_topic_root' });

  assert.deepEqual(capturedGet, {
    path: {
      message_id: 'om_topic_root',
    },
  });
  assert.equal(message?.messageId, 'om_topic_root');
  assert.equal(message?.threadId, 'omt_topic');
});

test('Feishu client can fetch chat display info', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  const calls: Array<{ body?: BodyInit | null; headers?: HeadersInit; method?: string; url: string }> = [];

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() { throw new Error('unexpected create call'); },
            async reply() { throw new Error('unexpected reply call'); },
          },
          messageReaction: {
            async create() { throw new Error('unexpected reaction create call'); },
            async delete() { throw new Error('unexpected reaction delete call'); },
          },
        },
      };
    },
    async fetch(input, init) {
      calls.push({ ...init, url: input.toString() });
      return jsonResponse({
        code: 0,
        data: {
          chat: {
            avatar: 'https://example.test/chat.png',
            chat_id: 'oc_test_chat',
            chat_type: 'group',
            name: '产品群',
          },
        },
      });
    },
    async fetchFeishuTenantAccessToken() {
      return { tenantAccessToken: 't-test' };
    },
  });

  assert.deepEqual(await client.getChat?.({ chatId: 'oc_test_chat' }), {
    avatarUrl: 'https://example.test/chat.png',
    chatId: 'oc_test_chat',
    chatName: '产品群',
    chatType: 'group',
  });
  assert.deepEqual(calls, [{
    headers: {
      Authorization: 'Bearer t-test',
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'GET',
    url: 'https://open.feishu.cn/open-apis/im/v1/chats/oc_test_chat',
  }]);
});

test('Feishu client can fetch basic user names by open_id', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  const calls: Array<{ body?: BodyInit | null; headers?: HeadersInit; method?: string; url: string }> = [];

  const client = createFeishuMessageClient(config, {
    createClient() {
      return {
        im: {
          message: {
            async create() { throw new Error('unexpected create call'); },
            async reply() { throw new Error('unexpected reply call'); },
          },
          messageReaction: {
            async create() { throw new Error('unexpected reaction create call'); },
            async delete() { throw new Error('unexpected reaction delete call'); },
          },
        },
      };
    },
    async fetch(input, init) {
      calls.push({ ...init, url: input.toString() });
      return jsonResponse({
        code: 0,
        data: {
          users: [{
            i18n_name: { en_us: 'Alice', zh_cn: '艾丽丝' },
            name: 'Alice',
            user_id: 'ou_alice',
          }],
        },
      });
    },
    async fetchFeishuTenantAccessToken() {
      return { tenantAccessToken: 't-test' };
    },
  });

  assert.deepEqual(await client.getUserBasics?.({ openIds: ['ou_alice'] }), [{
    i18nName: { en_us: 'Alice', zh_cn: '艾丽丝' },
    name: 'Alice',
    openId: 'ou_alice',
  }]);
  assert.deepEqual(calls, [{
    body: JSON.stringify({ user_ids: ['ou_alice'] }),
    headers: {
      Authorization: 'Bearer t-test',
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'POST',
    url: 'https://open.feishu.cn/open-apis/contact/v3/users/basic_batch?user_id_type=open_id',
  }]);
});

test('Feishu client can fetch tenant scope grant status', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  const calls: Array<{ body?: BodyInit | null; headers?: HeadersInit; method?: string; url: string }> = [];

  const scopes = await fetchFeishuAppScopes(config, {
    async fetch(input, init) {
      calls.push({ ...init, url: input.toString() });
      return jsonResponse({
        code: 0,
        data: {
          scopes: [{
            grant_status: 1,
            scope_name: 'contact:user.basic_profile:readonly',
          }, {
            grant_status: 2,
            scope_name: 'im:message:readonly',
          }],
        },
      });
    },
    async fetchFeishuTenantAccessToken() {
      return { tenantAccessToken: 't-test' };
    },
  });

  assert.deepEqual(scopes, [{
    granted: true,
    grantStatus: 1,
    scopeName: 'contact:user.basic_profile:readonly',
  }, {
    granted: false,
    grantStatus: 2,
    scopeName: 'im:message:readonly',
  }]);
  assert.deepEqual(calls, [{
    headers: {
      Authorization: 'Bearer t-test',
      'Content-Type': 'application/json; charset=utf-8',
    },
    method: 'GET',
    url: 'https://open.feishu.cn/open-apis/application/v6/scopes',
  }]);
});

test('Feishu service reports missing profile-name scope with authorization link', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-scope-status-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      const service = new AgentFeishuService('scout', {
        async getFeishuAppScopes() {
          return [{
            granted: true,
            grantStatus: 1,
            scopeName: 'im:message:readonly',
          }];
        },
      });

      const status = await service.getScopeStatus();

      assert.equal(status.connected, true);
      assert.equal(status.appId, 'cli_test');
      assert.equal(status.profileName.state, 'missing');
      assert.equal(status.profileName.granted, false);
      assert.equal(status.profileName.scope, 'contact:user.basic_profile:readonly');
      assert.match(
        status.profileName.authUrl ?? '',
        /^https:\/\/open\.feishu\.cn\/app\/cli_test\/auth\?/,
      );
      assert.match(status.profileName.authUrl ?? '', /contact%3Auser\.basic_profile%3Areadonly/);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu service reports granted profile-name scope', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-scope-granted-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      const service = new AgentFeishuService('scout', {
        async getFeishuAppScopes() {
          return [{
            granted: true,
            grantStatus: 1,
            scopeName: 'contact:user.basic_profile:readonly',
          }];
        },
      });

      const status = await service.getScopeStatus();

      assert.equal(status.profileName.state, 'granted');
      assert.equal(status.profileName.granted, true);
      assert.equal(status.profileName.authUrl, undefined);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('Feishu message updates use the SDK update endpoint', async () => {
  const config: FeishuConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
  };
  let capturedUpdate: unknown;

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
            async update(input) {
              capturedUpdate = input;
              return {
                data: {
                  chat_id: 'oc_test_chat',
                  message_id: 'om_target_message',
                  thread_id: 'omt_topic',
                },
              };
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

  const result = await client.updatePost?.({
    content: {
      zh_cn: {
        content: [[{ tag: 'text', text: 'updated post' }]],
        title: '',
      },
    },
    messageId: 'om_target_message',
  });

  assert.deepEqual(capturedUpdate, {
    data: {
      content: JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'text', text: 'updated post' }]],
          title: '',
        },
      }),
      msg_type: 'post',
    },
    path: {
      message_id: 'om_target_message',
    },
  });
  assert.deepEqual(result, {
    chatId: 'oc_test_chat',
    messageId: 'om_target_message',
    threadId: 'omt_topic',
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
              async getChat(input) {
                assert.deepEqual(input, { chatId: 'oc_target_chat' });
                return { chatId: 'oc_target_chat', chatName: '产品群', chatType: 'group' };
              },
              async listMessages(input) {
                reads.push(input);
                return {
                  hasMore: true,
                  messages: [{
                    bodyContent: JSON.stringify({ text: 'hello @_user_1' }),
                    chatId: 'oc_target_chat',
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
                };
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
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
      const completed = allActivities(await loadState())
        .filter((activity) => activity.type === 'tool.call.completed')
        .at(-1);
      assert.equal(completed?.payload?.['channelDisplayName'], '产品群');
      assert.equal(completed?.payload?.['channelName'], '产品群');
    });

    assert.deepEqual(reads, [{ chatId: 'oc_target_chat', cursor: 'cursor-1', limit: 2 }]);
    const output = logLines.join('\n');
    assert.match(
      output,
      /\[platform=feishu chat_id=oc_target_chat chat_name="产品群" message_id=om_test_message time=2026-06-02T14:20:00\.000Z user_id=ou_alice\] Alice: hello @Bob/,
    );
    assert.match(output, /\[page has_more=true next_cursor=cursor-next\]/);
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message read can fetch Feishu topic history explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-topic-read-test-'));
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
        { agent: 'scout', channel: 'oc_target_chat', limit: 2, threadTs: 'om_topic_root' },
        {
          createFeishuMessageClient() {
            return {
              async addReaction() {
                throw new Error('unexpected reaction add');
              },
              async downloadMessageResource() {
                throw new Error('unexpected file fetch');
              },
              async getMessage(input) {
                assert.deepEqual(input, { messageId: 'om_topic_root' });
                return {
                  chatId: 'oc_target_chat',
                  messageId: 'om_topic_root',
                  threadId: 'omt_topic',
                };
              },
              async listMessages(input) {
                reads.push(input);
                return {
                  hasMore: false,
                  messages: [{
                    bodyContent: JSON.stringify({ text: 'topic reply' }),
                    chatId: 'oc_target_chat',
                    createTime: '1780410000000',
                    messageId: 'om_topic_reply',
                    messageType: 'text',
                    parentId: 'om_topic_root',
                    rootId: 'om_topic_root',
                    sender: {
                      id: 'ou_alice',
                      idType: 'open_id',
                      senderName: 'Alice',
                      senderType: 'user',
                    },
                    threadId: 'omt_topic',
                  }],
                };
              },
              async removeReaction() {
                throw new Error('unexpected reaction remove');
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
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

      const completed = allActivities(await loadState())
        .filter((activity) => activity.type === 'tool.call.completed')
        .at(-1);
      assert.equal(completed?.payload?.['tool'], 'anima.message.read');
      assert.equal(completed?.payload?.['platform'], 'feishu');
      assert.equal(completed?.payload?.['channel'], 'oc_target_chat');
      assert.equal(completed?.payload?.['channelKind'], 'topic');
      assert.equal(completed?.payload?.['threadId'], 'omt_topic');
      assert.equal(completed?.payload?.['threadTs'], 'om_topic_root');
      assert.equal(completed?.payload?.['targetTs'], 'om_topic_root');
    });

    assert.deepEqual(reads, [{ chatId: 'oc_target_chat', limit: 2, threadId: 'omt_topic' }]);
    const output = logLines.join('\n');
    assert.match(
      output,
      /\[platform=feishu chat_id=oc_target_chat thread_id=omt_topic message_id=om_topic_reply time=2026-06-02T14:20:00\.000Z user_id=ou_alice\] Alice: topic reply/,
    );
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send can target a Feishu chat explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-explicit-chat-test-'));
  const sent: FeishuPostSendInput[] = [];
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      await runMessageSend(
        { agent: 'scout', channel: 'oc_target_chat', text: 'hello <at user_id="ou_alice"></at>' },
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
              async replyPost() {
                throw new Error('unexpected topic reply post');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendPost(input) {
                sent.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_sent' };
              },
              async sendText() {
                throw new Error('unexpected plain text send');
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.receiveId, 'oc_target_chat');
    assert.equal(sent[0]?.receiveIdType, 'chat_id');
    assert.deepEqual(sent[0]?.content.zh_cn.content, [[
      { tag: 'text', text: 'hello ' },
      { tag: 'at', user_id: 'ou_alice' },
    ]]);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message update can edit a Feishu message explicitly', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-message-update-test-'));
  const updates: FeishuPostUpdateInput[] = [];
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageUpdate(
        {
          agent: 'scout',
          channel: 'oc_target_chat',
          messageTs: 'om_target_message',
          text: 'Updated **Feishu** message.',
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
              async replyPost() {
                throw new Error('unexpected topic reply post');
              },
              async sendPost() {
                throw new Error('unexpected ordinary send post');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendText() {
                throw new Error('unexpected ordinary send');
              },
              async updatePost(input) {
                updates.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_target_message' };
              },
              async uploadFile() {
                throw new Error('unexpected file upload');
              },
            };
          },
        },
      );

      const completed = allActivities(await loadState())
        .filter((activity) => activity.type === 'external.effect.completed')
        .at(-1);
      assert.equal(completed?.payload?.['effect'], 'feishu.message.update');
      assert.equal(completed?.payload?.['tool'], 'anima.message.update');
      assert.equal(completed?.payload?.['platform'], 'feishu');
      assert.equal(completed?.payload?.['channel'], 'oc_target_chat');
      assert.equal(completed?.payload?.['messageId'], 'om_target_message');
      assert.equal(completed?.payload?.['targetTs'], 'om_target_message');
      assert.equal(completed?.payload?.['status'], 'updated');
      assert.equal(completed?.payload?.['text'], 'Updated **Feishu** message.');
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.messageId, 'om_target_message');
    assert.deepEqual(updates[0]?.content.zh_cn.content, [[
      { tag: 'text', text: 'Updated ' },
      { tag: 'text', text: 'Feishu', style: ['bold'] },
      { tag: 'text', text: ' message.' },
    ]]);
    assert.equal(
      logLines.at(-1),
      'updated successfully. feishu chat_id=oc_target_chat, message_id=om_target_message.',
    );
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message send can target a Feishu owner open_id and record greeting delivery', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-owner-send-test-'));
  const sent: Array<{ receiveId: string; receiveIdType: string }> = [];
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
              async replyPost() {
                throw new Error('unexpected topic reply post');
              },
              async sendUploadedFile() {
                throw new Error('unexpected file send');
              },
              async sendPost(input) {
                sent.push(input);
                return { chatId: 'oc_owner_dm', messageId: 'om_owner_hello' };
              },
              async sendText() {
                throw new Error('unexpected plain text send');
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

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.receiveId, 'ou_owner');
    assert.equal(sent[0]?.receiveIdType, 'open_id');
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
  const replies: Array<{ messageId: string; replyInThread: boolean }> = [];
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
              async replyText() {
                throw new Error('unexpected plain text topic reply');
              },
              async replyPost(input) {
                replies.push(input);
                return { chatId: 'oc_target_chat', messageId: 'om_sent', threadId: 'omt_topic' };
              },
              async sendPost() {
                throw new Error('unexpected ordinary send post');
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

    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.messageId, 'om_topic_root');
    assert.equal(replies[0]?.replyInThread, true);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message react can add a Feishu reaction by message id', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-reaction-add-test-'));
  const adds: FeishuReactionAddInput[] = [];
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageReact(
        {
          agent: 'scout',
          channel: 'oc_target_chat',
          messageId: 'om_target_message',
          name: 'Thumbsup',
        },
        {
          createFeishuMessageClient() {
            return {
              async addReaction(input) {
                adds.push(input);
                return { reactionId: 'reaction_1' };
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
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
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

      const activities = allActivities(await loadState());
      const completed = activities
        .filter((activity) => activity.type === 'external.effect.completed')
        .at(-1);
      assert.equal(completed?.payload?.['effect'], 'feishu.reaction');
      assert.equal(completed?.payload?.['tool'], 'anima.message.react');
      assert.equal(completed?.payload?.['platform'], 'feishu');
      assert.equal(completed?.payload?.['channel'], 'oc_target_chat');
      assert.equal(completed?.payload?.['messageId'], 'om_target_message');
      assert.equal(completed?.payload?.['targetTs'], 'om_target_message');
      assert.equal(completed?.payload?.['action'], 'added');
      assert.equal(completed?.payload?.['name'], 'Thumbsup');
      assert.equal(completed?.payload?.['reactionId'], 'reaction_1');
    });

    assert.deepEqual(adds, [{ emojiType: 'Thumbsup', messageId: 'om_target_message' }]);
    assert.equal(
      logLines.at(-1),
      'reaction added successfully. feishu chat_id=oc_target_chat, message_id=om_target_message, reaction=Thumbsup, reaction_id=reaction_1.',
    );
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message react can remove a Feishu reaction with a reaction id', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-reaction-remove-test-'));
  const removes: FeishuReactionRemoveInput[] = [];
  const logLines: string[] = [];
  const originalLog = console.log;
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '));
      };
      await runMessageReact(
        {
          agent: 'scout',
          channel: 'oc_target_chat',
          messageId: 'om_target_message',
          name: 'Thumbsup',
          reactionId: 'reaction_1',
          remove: true,
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
              async removeReaction(input) {
                removes.push(input);
              },
              async replyText() {
                throw new Error('unexpected topic reply');
              },
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
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

    assert.deepEqual(removes, [{ messageId: 'om_target_message', reactionId: 'reaction_1' }]);
    assert.equal(
      logLines.at(-1),
      'reaction removed successfully. feishu chat_id=oc_target_chat, message_id=om_target_message, reaction=Thumbsup, reaction_id=reaction_1.',
    );
  } finally {
    console.log = originalLog;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message react remove requires reaction id for Feishu messages', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-feishu-reaction-validation-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeFeishuConfig(stateDir);
      await assert.rejects(
        () => runMessageReact({
          agent: 'scout',
          channel: 'oc_target_chat',
          messageId: 'om_target_message',
          remove: true,
        }),
        /requires --reaction-id/,
      );
    });
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
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
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
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
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
              async replyPost() {
                return {};
              },
              async sendPost() {
                return {};
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
