import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebClient } from '@slack/web-api';

import type { FeishuConfig } from '../../shared/agent-config.js';
import type { SlackInboxItem } from '../../shared/inbox.js';
import { FeishuMessageTransport } from '../transports/feishu-message-transport.js';
import type { FeishuMessageClient } from '../feishu/client.js';
import type { FeishuReceiveMessageEvent } from '../feishu/events.js';
import { SlackProfileResolver } from '../slack/profiles.js';
import { SlackInboxSubscriber } from '../inbox/slack-subscriber.js';
import type { SlackMessageEnvelope, SlackRawMessageEvent } from '../inbox/slack-events.js';
import { muteSubscriptionForAgent } from '../inbox/subscription.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { SubscriptionStore } from '../storage/schema/subscription.store.js';
import { withAnimaHome } from './anima-home.js';
import { allActivities, loadState } from './helpers/state.js';

const AGENT_ID = 'scout';
const NOW = '2026-06-02T14:00:00.000Z';

interface CapturedIngest {
  activities: unknown[];
  apiCalls: string[];
  log: unknown;
  outcome: 'queued' | 'suppressed';
  queuedItem?: unknown;
}

test('Slack wake ingest decision matrix golden logs, queue outcomes, and attention records', async () => {
  const cases: Array<{
    name: string;
    event: SlackRawMessageEvent;
    expectedLog: unknown;
    expectedOutcome: CapturedIngest['outcome'];
    prepare?(queue: WakeQueueService): Promise<void>;
    expectedActivityPayloads?: unknown[];
    expectedApiCalls?: string[];
  }> = [{
    name: 'mention wakes',
    event: slackEvent({ text: '<@U-bot> review this', ts: '1780408800.000001', type: 'app_mention' }),
    expectedLog: {
      agentRuntime: 'codex-cli',
      duplicate: false,
      subscription: {
        kind: 'thread',
        status: 'following',
        subscriptionId: 'slack-subscription:scout:C-team:thread:1780408800.000001',
        threadTs: '1780408800.000001',
      },
      ingested: true,
      queued: true,
      reason: 'mention',
      itemId: 'slack:T-golden:C-team:1780408800.000001',
      surface: {
        channelId: 'C-team',
        channelName: 'team',
        id: 'slack:T-golden:C-team',
        kind: 'channel',
        teamId: 'T-golden',
        visibility: 'public',
      },
    },
    expectedOutcome: 'queued',
  }, {
    name: 'dm wakes',
    event: slackEvent({ channel: 'D-owner', channel_type: 'im', text: 'hello', ts: '1780408801.000001' }),
    expectedLog: {
      agentRuntime: 'codex-cli',
      duplicate: false,
      ingested: true,
      queued: true,
      reason: 'dm',
      itemId: 'slack:T-golden:D-owner:1780408801.000001',
      surface: {
        channelId: 'D-owner',
        channelName: 'owner-dm',
        id: 'slack:T-golden:D-owner',
        kind: 'dm',
        teamId: 'T-golden',
        visibility: 'private',
      },
    },
    expectedOutcome: 'queued',
  }, {
    name: 'followed thread wakes with attention suggestion',
    event: slackEvent({
      text: 'thread follow-up',
      thread_ts: '1780408700.000001',
      ts: '1780408802.000001',
    }),
    async prepare() {
      await seedSubscription({
        channelId: 'C-team',
        kind: 'thread',
        threadTs: '1780408700.000001',
      });
    },
    expectedLog: {
      agentRuntime: 'codex-cli',
      duplicate: false,
      subscription: {
        kind: 'thread',
        status: 'following',
        subscriptionId: 'slack-subscription:scout:C-team:thread:1780408700.000001',
        threadTs: '1780408700.000001',
      },
      ingested: true,
      queued: true,
      reason: 'thread_follow',
      itemId: 'slack:T-golden:C-team:1780408802.000001',
      surface: {
        channelId: 'C-team',
        channelName: 'team',
        id: 'slack:T-golden:C-team:thread:1780408700.000001',
        kind: 'thread',
        teamId: 'T-golden',
        threadTs: '1780408700.000001',
        visibility: 'public',
      },
    },
    expectedOutcome: 'queued',
    expectedActivityPayloads: [{
      channelId: 'C-team',
      channelName: 'team',
      platform: 'slack',
      suggestion: "You've been reading thread 1780408700.000001 in C-team without posting. If it is not relevant, mute it with `anima subscription mute --channel C-team --thread-ts 1780408700.000001`.",
      threadTs: '1780408700.000001',
    }],
  }, {
    name: 'muted ignored',
    event: slackEvent({ text: 'muted chatter', ts: '1780408803.000001' }),
    async prepare() {
      await muteSubscriptionForAgent({ agentId: AGENT_ID, channelId: 'C-team', nowMs: Date.parse(NOW) });
    },
    expectedLog: {
      agentRuntime: 'codex-cli',
      channel: 'C-team',
      ignored: true,
      ingested: false,
      reason: 'muted',
      ts: '1780408803.000001',
    },
    expectedOutcome: 'suppressed',
    expectedApiCalls: [],
  }, {
    name: 'not addressed ignored',
    event: slackEvent({
      channel: 'C-random',
      text: 'background thread chatter',
      thread_ts: '1780408704.000001',
      ts: '1780408804.000001',
    }),
    expectedLog: {
      agentRuntime: 'codex-cli',
      channel: 'C-random',
      ignored: true,
      ingested: false,
      reason: 'not_addressed',
      ts: '1780408804.000001',
    },
    expectedOutcome: 'suppressed',
    expectedApiCalls: [],
  }, {
    name: 'duplicate suppressed after decision',
    event: slackEvent({ text: '<@U-bot> duplicate', ts: '1780408805.000001', type: 'app_mention' }),
    async prepare(queue) {
      await queue.enqueue(slackQueuedItem('slack:T-golden:C-team:1780408805.000001'));
    },
    expectedLog: {
      agentRuntime: 'codex-cli',
      duplicate: true,
      ingested: false,
      queued: false,
      reason: 'mention',
      itemId: 'slack:T-golden:C-team:1780408805.000001',
      surface: {
        channelId: 'C-team',
        id: 'slack:T-golden:C-team',
        kind: 'channel',
        teamId: 'T-golden',
        visibility: 'public',
      },
    },
    expectedOutcome: 'suppressed',
  }];

  for (const item of cases) {
    await withIngestHome('slack', async (stateDir) => {
      await writeAgentConfig(stateDir, { slack: { botProfileSyncedAt: '2099-01-01T00:00:00.000Z' } });
      const queue = new WakeQueueService(AGENT_ID);
      await item.prepare?.(queue);

      const result = await captureSlackIngest(queue, item.event);

      assert.deepEqual(result.log, item.expectedLog, item.name);
      assert.equal(result.outcome, item.expectedOutcome, item.name);
      assert.deepEqual(result.activities.map((activity) => (activity as { payload?: unknown }).payload), item.expectedActivityPayloads ?? [], item.name);
      if (item.expectedApiCalls) assert.deepEqual(result.apiCalls, item.expectedApiCalls, item.name);
    });
  }
});

test('Feishu wake ingest decision matrix golden logs, queue outcomes, and attention records', async () => {
  const cases: Array<{
    name: string;
    event: FeishuReceiveMessageEvent;
    expectedLog: unknown;
    expectedOutcome: CapturedIngest['outcome'];
    prepare?(queue: WakeQueueService): Promise<void>;
    expectedActivityPayloads?: unknown[];
    expectedApiCalls?: string[];
  }> = [{
    name: 'mention wakes',
    event: feishuEvent({
      message: {
        chat_id: 'oc_group',
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 review this' }),
        mentions: [{
          id: { open_id: 'ou_anima_bot' },
          key: '@_user_1',
          mentioned_type: 'app',
          name: 'Anima',
        }],
        message_id: 'om_mention',
      },
    }),
    expectedLog: {
      agentRuntime: 'kimi-cli',
      duplicate: false,
      subscription: {
        kind: 'channel',
        status: 'following',
        subscriptionId: 'slack-subscription:scout:oc_group:channel',
      },
      ingested: true,
      itemId: 'feishu:tenant_test:oc_group:om_mention',
      platform: 'feishu',
      queued: true,
      reason: 'mention',
      surface: {
        chatId: 'oc_group',
        chatType: 'group',
      },
    },
    expectedOutcome: 'queued',
  }, {
    name: 'dm wakes',
    event: feishuEvent({
      message: {
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_id: 'om_dm',
      },
    }),
    expectedLog: {
      agentRuntime: 'kimi-cli',
      duplicate: false,
      ingested: true,
      itemId: 'feishu:tenant_test:oc_p2p:om_dm',
      platform: 'feishu',
      queued: true,
      reason: 'dm',
      surface: {
        chatId: 'oc_p2p',
        chatType: 'p2p',
      },
    },
    expectedOutcome: 'queued',
  }, {
    name: 'followed chat wakes with attention suggestion',
    event: feishuEvent({
      message: {
        chat_id: 'oc_group',
        chat_type: 'group',
        content: JSON.stringify({ text: 'group follow-up' }),
        message_id: 'om_followed',
      },
    }),
    async prepare() {
      await seedSubscription({ channelId: 'oc_group', kind: 'channel' });
    },
    expectedLog: {
      agentRuntime: 'kimi-cli',
      duplicate: false,
      subscription: {
        kind: 'channel',
        status: 'following',
        subscriptionId: 'slack-subscription:scout:oc_group:channel',
      },
      ingested: true,
      itemId: 'feishu:tenant_test:oc_group:om_followed',
      platform: 'feishu',
      queued: true,
      reason: 'channel_follow',
      surface: {
        chatId: 'oc_group',
        chatType: 'group',
      },
    },
    expectedOutcome: 'queued',
    expectedActivityPayloads: [{
      channelId: 'oc_group',
      channelKind: 'group',
      platform: 'feishu',
      suggestion: "You've been reading Feishu chat oc_group without posting. If it is not relevant, mute it with `anima subscription mute --chat-id oc_group`.",
    }],
  }, {
    name: 'muted ignored',
    event: feishuEvent({
      message: {
        chat_id: 'oc_group',
        chat_type: 'group',
        content: JSON.stringify({ text: 'muted group' }),
        message_id: 'om_muted',
      },
    }),
    async prepare() {
      await muteSubscriptionForAgent({ agentId: AGENT_ID, channelId: 'oc_group', nowMs: Date.parse(NOW) });
    },
    expectedLog: {
      agentRuntime: 'kimi-cli',
      ignored: true,
      ingested: false,
      platform: 'feishu',
      reason: 'muted',
    },
    expectedOutcome: 'suppressed',
    expectedApiCalls: [],
  }, {
    name: 'not addressed ignored',
    event: feishuEvent({
      message: {
        chat_id: '',
        chat_type: 'group',
        content: JSON.stringify({ text: 'background group' }),
        message_id: 'om_not_addressed',
      },
    }),
    expectedLog: {
      agentRuntime: 'kimi-cli',
      ignored: true,
      ingested: false,
      platform: 'feishu',
      reason: 'not_addressed',
    },
    expectedOutcome: 'suppressed',
    expectedApiCalls: [],
  }, {
    name: 'duplicate suppressed after decision',
    event: feishuEvent({
      message: {
        chat_id: 'oc_p2p',
        chat_type: 'p2p',
        message_id: 'om_duplicate',
      },
    }),
    async prepare(queue) {
      await queue.enqueue({
        id: 'feishu:tenant_test:oc_p2p:om_duplicate',
        kind: 'feishu',
        receivedAt: NOW,
        handling: { createdAt: NOW, queuedAt: NOW, status: 'queued', updatedAt: NOW },
        appId: 'cli_test',
        chatId: 'oc_p2p',
        chatType: 'p2p',
        messageId: 'om_duplicate',
        text: 'duplicate',
      });
    },
    expectedLog: {
      agentRuntime: 'kimi-cli',
      duplicate: true,
      ingested: false,
      itemId: 'feishu:tenant_test:oc_p2p:om_duplicate',
      platform: 'feishu',
      queued: false,
      reason: 'dm',
      surface: {
        chatId: 'oc_p2p',
        chatType: 'p2p',
      },
    },
    expectedOutcome: 'suppressed',
  }];

  for (const item of cases) {
    await withIngestHome('feishu', async (stateDir) => {
      await writeAgentConfig(stateDir, { feishu: { botProfileSyncedAt: '2099-01-01T00:00:00.000Z' } });
      const queue = new WakeQueueService(AGENT_ID);
      await item.prepare?.(queue);

      const result = await captureFeishuIngest(queue, item.event);

      assert.deepEqual(result.log, item.expectedLog, item.name);
      assert.equal(result.outcome, item.expectedOutcome, item.name);
      assert.deepEqual(result.activities.map((activity) => (activity as { payload?: unknown }).payload), item.expectedActivityPayloads ?? [], item.name);
      if (item.expectedApiCalls) assert.deepEqual(result.apiCalls, item.expectedApiCalls, item.name);
    });
  }
});

async function captureSlackIngest(
  queue: WakeQueueService,
  event: SlackRawMessageEvent,
): Promise<CapturedIngest> {
  const logs: string[] = [];
  const calls: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    const subscriber = Object.create(SlackInboxSubscriber.prototype) as Record<string, unknown>;
    subscriber['options'] = {
      agentRuntimeKind: 'codex-cli',
      appToken: 'xapp-test',
      botToken: 'xoxb-test',
      queue,
    };
    subscriber['slackProfiles'] = new SlackProfileResolver();
    subscriber['botDisplayInfoSyncInFlight'] = false;
    await (subscriber as unknown as {
      handleSlackEvent(body: unknown, event: unknown, client?: WebClient): Promise<void>;
    }).handleSlackEvent({ team_id: 'T-golden' } satisfies SlackMessageEnvelope, event, slackClient(calls));
  } finally {
    console.log = originalLog;
  }
  const queued = await queue.list();
  const log = parseSingleJsonLog(logs);
  return {
    activities: await attentionActivities(),
    apiCalls: calls,
    log,
    outcome: isQueuedLog(log) ? 'queued' : 'suppressed',
    queuedItem: queued.find((item) => item.id.endsWith(`:${event.ts}`)),
  };
}

async function captureFeishuIngest(
  queue: WakeQueueService,
  event: FeishuReceiveMessageEvent,
): Promise<CapturedIngest> {
  const logs: string[] = [];
  const calls: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    const transport = new FeishuMessageTransport(
      {
        agentRuntimeKind: 'kimi-cli',
        config: feishuTransportConfig({ botOpenId: 'ou_anima_bot' }),
        queue,
      },
      { createMessageClient: () => feishuClient(calls) },
    );
    await (transport as unknown as {
      handleReceiveMessage(data: unknown): Promise<void>;
    }).handleReceiveMessage(event);
  } finally {
    console.log = originalLog;
  }
  const expectedId = `feishu:tenant_test:${event.message.chat_id}:${event.message.message_id}`;
  const queued = await queue.list();
  const log = parseSingleJsonLog(logs);
  return {
    activities: await attentionActivities(),
    apiCalls: calls,
    log,
    outcome: isQueuedLog(log) ? 'queued' : 'suppressed',
    queuedItem: queued.find((item) => item.id === expectedId),
  };
}

async function attentionActivities(): Promise<unknown[]> {
  return allActivities(await loadState()).filter((activity) => activity.type === 'anima.attention.suggestion');
}

function parseSingleJsonLog(logs: string[]): unknown {
  assert.equal(logs.length, 1);
  const log = logs[0];
  assert.ok(log);
  return JSON.parse(log) as unknown;
}

function isQueuedLog(log: unknown): boolean {
  return Boolean(log && typeof log === 'object' && (log as { queued?: unknown }).queued === true);
}

function slackEvent(overrides: Partial<SlackRawMessageEvent>): SlackRawMessageEvent {
  return {
    channel: 'C-team',
    channel_type: 'channel',
    text: 'hello',
    ts: '1780408800.000000',
    type: 'message',
    user: 'U-alice',
    ...overrides,
  };
}

function slackClient(calls: string[]): WebClient {
  return {
    chat: {
      getPermalink: async (args: { channel?: string; message_ts?: string }) => {
        calls.push(`chat.getPermalink:${args.channel ?? ''}:${args.message_ts ?? ''}`);
        return { ok: true, permalink: `https://golden.slack.test/${args.channel}/${args.message_ts}` };
      },
    },
    conversations: {
      info: async (args: { channel?: string }) => {
        calls.push(`conversations.info:${args.channel ?? ''}`);
        return {
          channel: {
            id: args.channel,
            name: args.channel === 'D-owner' ? 'owner-dm' : args.channel === 'C-random' ? 'random' : 'team',
            name_normalized: args.channel === 'D-owner' ? 'owner-dm' : args.channel === 'C-random' ? 'random' : 'team',
          },
          ok: true,
        };
      },
    },
    users: {
      info: async (args: { user?: string }) => {
        calls.push(`users.info:${args.user ?? ''}`);
        return {
          ok: true,
          user: {
            id: args.user,
            name: args.user === 'U-bot' ? 'anima' : 'alice',
            profile: {
              display_name: args.user === 'U-bot' ? 'Anima' : 'Alice',
              real_name: args.user === 'U-bot' ? 'Anima Bot' : 'Alice Lee',
            },
          },
        };
      },
    },
  } as unknown as WebClient;
}

function slackQueuedItem(id: string): SlackInboxItem {
  return {
    id,
    kind: 'slack',
    receivedAt: NOW,
    handling: { createdAt: NOW, queuedAt: NOW, status: 'queued', updatedAt: NOW },
    actor: { userId: 'U-alice' },
    channelId: 'C-team',
    messageTs: id.split(':').at(-1) ?? '1780408800.000001',
    teamId: 'T-golden',
    text: 'already queued',
  };
}

function feishuEvent(overrides: Omit<Partial<FeishuReceiveMessageEvent>, 'message' | 'sender'> & {
  message?: Partial<FeishuReceiveMessageEvent['message']>;
  sender?: Partial<FeishuReceiveMessageEvent['sender']>;
}): FeishuReceiveMessageEvent {
  const { message, sender, ...rest } = overrides;
  return {
    app_id: 'cli_test',
    create_time: '1780410000000',
    event_id: `evt-${message?.message_id ?? 'feishu'}`,
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
      sender_id: { open_id: 'ou_alice', union_id: 'on_alice', user_id: 'user_alice' },
      sender_type: 'user',
      tenant_key: 'tenant_test',
      ...sender,
    },
  };
}

function feishuClient(calls: string[]): FeishuMessageClient {
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
    async getMessage(input) {
      calls.push(`getMessage:${input.messageId}`);
      return undefined;
    },
  };
}

function feishuTransportConfig(overrides: Partial<FeishuConfig> = {}): FeishuConfig {
  return {
    appId: 'cli_test',
    appSecret: 'secret',
    connected: true,
    encryptKey: '',
    verificationToken: '',
    ...overrides,
  };
}

async function seedSubscription(input: {
  channelId: string;
  kind: 'channel' | 'thread';
  threadTs?: string;
}): Promise<void> {
  const subscriptionId = input.kind === 'thread'
    ? `slack-subscription:${AGENT_ID}:${input.channelId}:thread:${input.threadTs}`
    : `slack-subscription:${AGENT_ID}:${input.channelId}:channel`;
  const now = new Date().toISOString();
  if (input.kind === 'thread') {
    assert.ok(input.threadTs);
    await new SubscriptionStore(AGENT_ID).replace({
      agentId: AGENT_ID,
      channelId: input.channelId,
      kind: 'thread',
      lastActivityAt: now,
      silentWakeStartedAt: now,
      subscriptionId,
      threadTs: input.threadTs,
      updatedAt: now,
      wakeCount: 5,
      wakeWindowStartedAt: now,
      wakesSinceLastPost: 5,
    });
    return;
  }
  await new SubscriptionStore(AGENT_ID).replace({
    agentId: AGENT_ID,
    channelId: input.channelId,
    kind: 'channel',
    lastActivityAt: now,
    silentWakeStartedAt: now,
    subscriptionId,
    updatedAt: now,
    wakeCount: 5,
    wakeWindowStartedAt: now,
    wakesSinceLastPost: 5,
  });
}

async function writeAgentConfig(configDir: string, input: {
  feishu?: Partial<FeishuConfig>;
  slack?: Record<string, unknown>;
}): Promise<void> {
  const agentDir = join(configDir, 'agents', AGENT_ID);
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
        ...input.feishu,
      },
      homePath,
      id: AGENT_ID,
      provider: { kind: 'codex-cli', model: 'gpt-5.5' },
      slack: {
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        teamId: 'T-golden',
        ...input.slack,
      },
    }, null, 2)}\n`,
    'utf8',
  );
}

async function withIngestHome<T>(prefix: string, body: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), `anima-${prefix}-ingest-golden-test-`));
  try {
    return await withAnimaHome(stateDir, () => body(stateDir));
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
}
