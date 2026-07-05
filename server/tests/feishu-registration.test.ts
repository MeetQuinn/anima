import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { sleep, writeFeishuAgentConfig } from './helpers/harness.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeFeishuMessage } from '../feishu/events.js';
import { fetchFeishuBotInfo, fetchFeishuTenantAccessToken } from '../feishu/client.js';
import { AgentFeishuService } from '../agents/agent-feishu.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { buildCodeAgentDeliveryPrompt } from '../runtime/delivery-prompt.js';
import { messageFromInboxItem } from '../messages/message.projection.js';
import { withAnimaHome } from './anima-home.js';
import type { FeishuConfig } from '../../shared/agent-config.js';
import { makeFeishuEvent, waitForRegistration } from './helpers/feishu.js';

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
      await writeFeishuAgentConfig(stateDir, {
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
      await writeFeishuAgentConfig(stateDir);

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
      // settle window: asserting absence of late registration overwriting manual Feishu config.
      await sleep(50);

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
      await writeFeishuAgentConfig(stateDir);

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
  assert.match(text, /\[platform=feishu channel=ou_owner receive_id_type=open_id time=2026-01-01T00:00:00Z user_id=ou_owner\]/);
  assert.match(text, /Your owner is the person who connected you to Feishu/);
  assert.doesNotMatch(text, /Reply target:|Use `anima message send/);
  assert.doesNotMatch(text, /Slack|Lark|<@|ou_owner.*owner is/);
});
