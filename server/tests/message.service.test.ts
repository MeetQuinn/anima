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

test('message service projects legacy inbox and activity records into one ledger', async () => {
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
      await activityServiceForAgent('scout').record({
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
      await new MessageStore('scout').markLegacyBackfilled();

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
