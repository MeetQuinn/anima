import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { WakeQueueStore, type WakeQueueFile } from '../storage/schema/wake-queue.store.js';
import { makeSlackEvent } from './helpers/slack.js';
import { withAnimaHome } from './anima-home.js';
import { loadState } from './helpers/state.js';

function memoryWakeQueueStore(initial: WakeQueueFile = {}) {
  let state = { ...initial };
  return {
    async read() {
      return state;
    },
    async write(value: WakeQueueFile) {
      state = value;
    },
  };
}

test('wake queue store ignores duplicate Slack message deliveries', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-queued-dedupe-test-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const queue = new WakeQueueService('scout');
      const first = await queue.enqueue(
        makeSlackEvent({
          channelId: 'C-product',
          eventId: 'slack:T-demo:C-product:1770000010.000001',
          teamId: 'T-demo',
          text: '<@U999> remember bagels',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
      );

      const second = await queue.enqueue(
        makeSlackEvent({
          channelId: 'C-product',
          eventId: 'slack:T-demo:C-product:1770000010.000001',
          teamId: 'T-demo',
          text: '<@U999> remember bagels',
          ts: '1770000010.000001',
          userId: 'U1',
        }),
      );

      assert.equal(first.queued, true);
      assert.equal(second.duplicate, true);
      assert.equal(second.item.id, first.item.id);
      assert.deepEqual((await queue.listRunnable()).map((item) => item.id), [first.item.id]);

      const state = await loadState();
      assert.equal(Object.keys(state.events).length, 1);
      assert.equal(Object.keys(state.items).length, 1);
      assert.equal(state.items[first.item.id]?.id, 'slack:T-demo:C-product:1770000010.000001');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('wake queue store can use an injected file persistence', async () => {
  const queue = new WakeQueueService(
    'scout',
    new WakeQueueStore('scout', memoryWakeQueueStore()),
    { recordInboxItem: async () => undefined },
  );
  const event = makeSlackEvent({
    channelId: 'D-user',
    eventId: 'evt-injected-store',
    teamId: 'T-demo',
    text: 'queued without filesystem store',
    ts: '1770000010.000001',
    userId: 'U1',
  });

  const decision = await queue.enqueue(event);
  assert.equal(decision.queued, true);

  const claimed = await queue.claimNext('worker-1');
  assert.equal(claimed?.id, event.id);
  assert.equal(claimed?.handling.status, 'running');

  await queue.complete(event.id);

  const completed = await queue.find(event.id);
  assert.equal(completed?.handling.status, 'completed');
  assert.deepEqual((await queue.list()).map((item) => item.id), [event.id]);
});

test('wake queue enqueue does not fail when message ledger write fails', async () => {
  const warnings: string[] = [];
  const queue = new WakeQueueService(
    'scout',
    new WakeQueueStore('scout', memoryWakeQueueStore()),
    { recordInboxItem: async () => { throw new Error('ledger down'); } },
    { warn: (message) => warnings.push(message) },
  );
  const event = makeSlackEvent({
    channelId: 'D-user',
    eventId: 'evt-ledger-failure',
    teamId: 'T-demo',
    text: 'queued even when ledger is down',
    ts: '1770000011.000001',
    userId: 'U1',
  });

  const decision = await queue.enqueue(event);

  assert.equal(decision.queued, true);
  assert.deepEqual((await queue.list()).map((item) => item.id), [event.id]);
  assert.match(warnings[0] ?? '', /ledger down/);
});

test('wake queue retention waits for legacy message backfill before pruning settled items', async () => {
  let legacyBackfilled = false;
  const oldSettled = makeSlackEvent({
    channelId: 'D-user',
    eventId: 'evt-old-settled',
    handling: {
      completedAt: '2000-01-01T00:00:00.000Z',
      createdAt: '2000-01-01T00:00:00.000Z',
      queuedAt: '2000-01-01T00:00:00.000Z',
      status: 'completed',
      updatedAt: '2000-01-01T00:00:00.000Z',
    },
    teamId: 'T-demo',
    text: 'old completed message',
    ts: '946684800.000001',
    userId: 'U1',
  });
  const oldQueued = makeSlackEvent({
    channelId: 'D-user',
    eventId: 'evt-old-queued',
    handling: {
      createdAt: '2000-01-01T00:00:00.000Z',
      queuedAt: '2000-01-01T00:00:00.000Z',
      status: 'queued',
      updatedAt: '2000-01-01T00:00:00.000Z',
    },
    teamId: 'T-demo',
    text: 'old queued message',
    ts: '946684801.000001',
    userId: 'U1',
  });
  const queue = new WakeQueueService(
    'scout',
    new WakeQueueStore('scout', memoryWakeQueueStore({
      [oldSettled.id]: oldSettled,
      [oldQueued.id]: oldQueued,
    })),
    {
      legacyBackfilled: async () => legacyBackfilled,
      recordInboxItem: async () => undefined,
    },
  );
  const event = makeSlackEvent({
    channelId: 'D-user',
    eventId: 'evt-new',
    teamId: 'T-demo',
    text: 'new message',
    ts: '1770000012.000001',
    userId: 'U1',
  });

  await queue.enqueue(event);
  assert.deepEqual((await queue.list()).map((item) => item.id), [oldSettled.id, oldQueued.id, event.id]);

  legacyBackfilled = true;
  await queue.complete(event.id);

  assert.deepEqual((await queue.list()).map((item) => item.id), [oldQueued.id, event.id]);
});
