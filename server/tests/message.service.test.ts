import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { activityServiceForAgent } from '../activities/activity.service.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { MessageStore } from '../storage/schema/message.store.js';
import type { AgentMessageRecord } from '../../shared/messages.js';
import { withToolActivity } from '../tools/tool-context.js';
import { withAnimaHome } from './anima-home.js';
import { makeSlackEvent } from './helpers/slack.js';

test('message service projects live inbox and outbox writes into one ledger', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-message-service-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await new WakeQueueService('scout').enqueue(
        makeSlackEvent({
          actor: { handle: 'alice' },
          channelId: 'C-product',
          channelName: 'product',
          eventId: 'evt-message-ledger-in',
          teamId: 'T-demo',
          text: 'Can you check the launch note?',
          timestamp: '2026-05-11T00:00:00.000Z',
          ts: '1770000100.000001',
          userId: 'U-alice',
        }),
      );
      const outboundActivity = await activityServiceForAgent('scout').record({
        createdAt: '2026-05-11T00:01:00.000Z',
        payload: {
          channel: 'C-product',
          channelName: 'product',
          effect: 'slack.message.send',
          status: 'completed',
          text: 'Looks good.',
          ts: '1770000101.000001',
        },
        type: 'external.effect.completed',
      });
      await messageServiceForAgent('scout').recordOutboxActivity(outboundActivity);

      const page = await messageServiceForAgent('scout').list({ limit: 10 });
      assert.deepEqual(page.entries.map((entry) => entry.direction), ['out', 'in']);
      assert.equal(page.entries[0]?.text, 'Looks good.');
      assert.equal(page.entries[1]?.actor, '@alice');

      const repeated = await messageServiceForAgent('scout').list({ limit: 10 });
      assert.equal(repeated.entries.length, 2);
      assert.equal((await new MessageStore('scout').readAll()).length, 2);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message service reads newest matching page without requiring a full ledger sort', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-message-page-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await new MessageStore('scout').appendManyIfAbsent([
        testMessage({ messageId: 'old-in', timestamp: '2026-05-11T00:00:00.000Z', direction: 'in' }),
        testMessage({ messageId: 'mid-out', timestamp: '2026-05-11T00:01:00.000Z', direction: 'out' }),
        testMessage({ messageId: 'new-in', timestamp: '2026-05-11T00:02:00.000Z', direction: 'in' }),
      ]);

      const firstPage = await messageServiceForAgent('scout').list({ limit: 2 });
      assert.deepEqual(firstPage.entries.map((entry) => entry.messageId), ['new-in', 'mid-out']);
      assert.equal(firstPage.nextCursor, '2026-05-11T00:01:00.000Z');

      const inboxPage = await messageServiceForAgent('scout').list({ direction: 'in', limit: 2 });
      assert.deepEqual(inboxPage.entries.map((entry) => entry.messageId), ['new-in', 'old-in']);
      assert.equal(inboxPage.nextCursor, null);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('message service list scopes to a single channel when given a channel filter', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-message-channel-filter-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await new MessageStore('scout').appendManyIfAbsent([
        channelMessage({ messageId: 'p1', timestamp: '2026-05-11T00:00:00.000Z', channelId: 'C-product', channelName: 'product' }),
        channelMessage({ messageId: 'r1', timestamp: '2026-05-11T00:01:00.000Z', channelId: 'C-random', channelName: 'random' }),
        channelMessage({ messageId: 'p2', timestamp: '2026-05-11T00:02:00.000Z', channelId: 'C-product', channelName: 'product' }),
        dmMessage({ messageId: 'd1', timestamp: '2026-05-11T00:03:00.000Z', channelId: 'D-alice', dmHandle: 'alice', dmUserId: 'U-alice' }),
      ]);

      const byId = await messageServiceForAgent('scout').list({ channel: 'C-product', limit: 10 });
      assert.deepEqual(byId.entries.map((e) => e.messageId), ['p2', 'p1']);

      const byName = await messageServiceForAgent('scout').list({ channel: '#product', limit: 10 });
      assert.deepEqual(byName.entries.map((e) => e.messageId), ['p2', 'p1']);

      const dmByHandle = await messageServiceForAgent('scout').list({ channel: '@alice', limit: 10 });
      assert.deepEqual(dmByHandle.entries.map((e) => e.messageId), ['d1']);

      const unscoped = await messageServiceForAgent('scout').list({ limit: 10 });
      assert.equal(unscoped.entries.length, 4);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('wake queue enqueue writes inbound messages without duplicate ledger rows', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-message-inbox-write-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const event = makeSlackEvent({
        channelId: 'D-alice',
        eventId: 'evt-message-ledger-dedupe',
        teamId: 'T-demo',
        text: 'hello',
        timestamp: '2026-05-11T00:00:00.000Z',
        ts: '1770000100.000001',
        userId: 'U-alice',
      });
      const queue = new WakeQueueService('scout');
      await queue.enqueue(event);
      await queue.enqueue(event);

      const messages = await new MessageStore('scout').readAll();
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.messageId, `msg_inbox:${event.id}`);
      assert.equal(messages[0]?.direction, 'in');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('wake queue enqueue preserves Slack message previews in the message ledger', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-message-preview-ledger-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const event = makeSlackEvent({
        channelId: 'D-owner',
        eventId: 'evt-message-preview-ledger',
        previews: [{
          authorName: 'Iris',
          channelId: 'D-private',
          files: [{
            id: 'F-unfurled-html',
            mimetype: 'text/html',
            name: 'curriculum.html',
            permalink: 'https://example.slack.com/files/U-author/F-unfurled-html/curriculum.html',
            sizeBytes: 35578,
          }],
          fromUrl: 'https://example.slack.com/archives/D-private/p1770000100000001',
          isPrivate: true,
          messageTs: '1770000100.000001',
          text: 'Preview delivered by Slack',
        }],
        teamId: 'T-demo',
        text: 'can you see this link?',
        timestamp: '2026-05-11T00:00:00.000Z',
        ts: '1770000200.000001',
        userId: 'U-owner',
      });

      await new WakeQueueService('scout').enqueue(event);

      const messages = await new MessageStore('scout').readAll();
      assert.deepEqual(messages[0]?.previews, [{
        authorName: 'Iris',
        channelId: 'D-private',
        files: [{
          id: 'F-unfurled-html',
          mimetype: 'text/html',
          name: 'curriculum.html',
          permalink: 'https://example.slack.com/files/U-author/F-unfurled-html/curriculum.html',
          sizeBytes: 35578,
        }],
        fromUrl: 'https://example.slack.com/archives/D-private/p1770000100000001',
        isPrivate: true,
        messageTs: '1770000100.000001',
        platform: 'slack',
        text: 'Preview delivered by Slack',
        type: 'message_unfurl',
      }]);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('tool activity does not fail successful effects when message ledger write fails', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-message-outbox-failure-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await mkdir(join(stateDir, 'agents/scout'), { recursive: true });
      await writeFile(join(stateDir, 'agents/scout/messages.jsonl'), '{not-json}\n', 'utf8');

      const result = await withMutedWarnings(() =>
        withToolActivity({
          audit: { agentId: 'scout' },
          basePayload: { tool: 'anima.message.send' },
          effectType: 'slack.message.send',
          op: async () => ({
            completedPayload: {
              channel: 'C-product',
              text: 'Sent successfully.',
              ts: '1770000102.000001',
            },
            result: 'ok',
          }),
        }),
      );

      assert.equal(result, 'ok');
      const activities = await activityServiceForAgent('scout').readAll();
      assert.deepEqual(activities.map((activity) => activity.type), [
        'external.effect.started',
        'external.effect.completed',
      ]);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

// iris's QA scenario for ask-post projection: the posted question must survive
// a crash after the post — a recovered agent's `anima outbox` shows it, and
// re-projecting the same activity (recovery/replay) never double-posts a row.
test('interactive ask posts project into the outbox once, surviving re-projection', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-message-ask-outbox-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      // Write through the live tool path, shaped like runAsk's payloads.
      await withToolActivity({
        audit: { agentId: 'scout' },
        basePayload: {
          channel: 'C-product',
          channelDisplayName: 'product',
          channelKind: 'channel',
          channelName: 'product',
          optionCount: 2,
          target: 'Ship the canary today?',
          tool: 'anima.ask',
        },
        effectType: 'slack.ask.post',
        op: async () => ({
          completedPayload: {
            askId: 'ask_test_1',
            messageTs: '1770000300.000001',
            optionLabels: ['Ship it', 'Hold'],
            payload: {
              channel: 'C-product',
              text: 'Ship the canary today?\n\nOptions:\n1. Ship it\n2. Hold\n\nNone fit? Just reply in this thread.',
            },
            question: 'Ship the canary today?',
          },
          result: undefined,
        }),
      });

      // "Recovery": a fresh service reads the persisted ledger (anima outbox).
      const outbox = await messageServiceForAgent('scout').list({ direction: 'out', limit: 10 });
      assert.equal(outbox.entries.length, 1);
      const entry = outbox.entries[0]!;
      assert.equal(entry.kind, 'message');
      assert.equal(entry.question, 'Ship the canary today?');
      assert.equal(entry.messageTs, '1770000300.000001');
      assert.equal(entry.channelId, 'C-product');
      assert.match(entry.text, /^Ship the canary today\?/);
      assert.match(entry.text, /1\. Ship it/);

      // Replaying the projection for the same activity must not duplicate.
      const completed = (await activityServiceForAgent('scout').readAll())
        .find((activity) => activity.type === 'external.effect.completed');
      assert.ok(completed);
      await messageServiceForAgent('scout').recordOutboxActivity(completed);
      const replayed = await messageServiceForAgent('scout').list({ direction: 'out', limit: 10 });
      assert.equal(replayed.entries.length, 1);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

// Older ask activities predate the recorded raw post payload: text falls back
// to question + options reconstruction.
test('ask projection reconstructs text when the raw post payload is absent', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-message-ask-fallback-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const activity = await activityServiceForAgent('scout').record({
        payload: {
          channel: 'C-product',
          effect: 'slack.ask.post',
          messageTs: '1770000301.000001',
          optionLabels: ['Yes', 'No'],
          question: 'Proceed?',
          status: 'completed',
          tool: 'anima.ask',
        },
        type: 'external.effect.completed',
      });
      const record = await messageServiceForAgent('scout').recordOutboxActivity(activity);
      assert.equal(record?.text, 'Proceed?\n\nOptions:\n1. Yes\n2. No');
      assert.equal(record?.question, 'Proceed?');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function withMutedWarnings<T>(op: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => undefined;
  try {
    return await op();
  } finally {
    console.warn = original;
  }
}

function testMessage(input: Pick<AgentMessageRecord, 'direction' | 'messageId' | 'timestamp'>): AgentMessageRecord {
  return {
    direction: input.direction,
    kind: 'message',
    messageId: input.messageId,
    source: { id: input.messageId, kind: 'activity' },
    text: input.messageId,
    timestamp: input.timestamp,
  };
}

function channelMessage(input: { messageId: string; timestamp: string; channelId: string; channelName: string }): AgentMessageRecord {
  return {
    ...testMessage({ direction: 'in', messageId: input.messageId, timestamp: input.timestamp }),
    channelKind: 'channel',
    channelId: input.channelId,
    channelName: input.channelName,
  };
}

function dmMessage(input: { messageId: string; timestamp: string; channelId: string; dmHandle: string; dmUserId: string }): AgentMessageRecord {
  return {
    ...testMessage({ direction: 'in', messageId: input.messageId, timestamp: input.timestamp }),
    channelKind: 'dm',
    channelId: input.channelId,
    dmHandle: input.dmHandle,
    dmUserId: input.dmUserId,
  };
}
