import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WebClient } from '@slack/web-api';

import { observeObservableSlackMessage, observeSlackEventAtIngress } from '../inbox/observed-conversation.js';
import { isObservableSlackMessage, isRoutableSlackMessage } from '../inbox/slack-events.js';
import { SlackInboxSubscriber } from '../inbox/slack-subscriber.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { SlackProfileResolver } from '../slack/profiles.js';
import { withAnimaHome } from './anima-home.js';
import {
  conversationThreadTs,
  ObservedConversationStore,
  observedConversationsDir,
  observedConversationFileStem,
  surfaceIdForObservation,
} from '../storage/schema/observed-conversation.store.js';
import { writeAgentConfigs, defaultAgentConfig } from './helpers/harness.js';

async function withAgentStore<T>(
  body: (store: ObservedConversationStore, agentId: string) => Promise<T>,
  options?: { maxArchives?: number; maxBytes?: number },
): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-obs-journal-'));
  try {
    await writeAgentConfigs(stateDir, [defaultAgentConfig('anima')]);
    return await withAnimaHome(stateDir, async () => {
      const store = new ObservedConversationStore('anima', options);
      return body(store, 'anima');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
}

/** Ingress-level handleSlackEvent (mirrors ingest-golden pattern). */
async function invokeHandleSlackEvent(input: {
  agentId: string;
  body?: { team_id?: string };
  event: Record<string, unknown>;
}): Promise<void> {
  const queue = new WakeQueueService(input.agentId);
  const subscriber = Object.create(SlackInboxSubscriber.prototype) as Record<string, unknown>;
  subscriber['options'] = {
    agentRuntimeKind: 'codex-cli',
    appToken: 'xapp-test',
    botUserId: 'U-bot',
    botToken: 'xoxb-test',
    queue,
  };
  subscriber['slackProfiles'] = new SlackProfileResolver();
  subscriber['botDisplayInfoSyncInFlight'] = false;
  const client = {
    chat: { getPermalink: async () => ({ ok: true, permalink: 'https://example.test/p' }) },
    conversations: { info: async () => ({ ok: true, channel: { name: 'test' } }) },
    users: { info: async () => ({ ok: true, user: { id: 'U1', name: 'u' } }) },
  } as unknown as WebClient;
  await (subscriber as unknown as {
    handleSlackEvent(body: unknown, event: unknown, client?: WebClient): Promise<void>;
  }).handleSlackEvent(input.body ?? { team_id: 'T1' }, input.event, client);
}

test('conversationThreadTs partitions top-level from thread replies', () => {
  assert.equal(conversationThreadTs({ messageTs: '1.0' }), undefined);
  assert.equal(conversationThreadTs({ messageTs: '1.0', threadTs: '1.0' }), undefined);
  assert.equal(conversationThreadTs({ messageTs: '2.0', threadTs: '1.0' }), '1.0');
});

test('surfaceIdForObservation keys DM, channel, and thread distinctly', () => {
  assert.equal(
    surfaceIdForObservation({ teamId: 'T1', channelId: 'D1', messageTs: '1.0' }),
    'slack:T1:D1',
  );
  assert.equal(
    surfaceIdForObservation({ teamId: 'T1', channelId: 'C1', messageTs: '1.0' }),
    'slack:T1:C1',
  );
  assert.equal(
    surfaceIdForObservation({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '2.0',
      threadTs: '1.0',
    }),
    'slack:T1:C1:thread:1.0',
  );
  assert.equal(
    surfaceIdForObservation({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      threadTs: '1.0',
    }),
    'slack:T1:C1',
  );
});

test('isObservableSlackMessage accepts userless bot_message; isRoutable does not', () => {
  const botOnly = {
    type: 'message',
    subtype: 'bot_message',
    channel: 'C1',
    ts: '1.0',
    text: 'from a bot',
    bot_id: 'B1',
  };
  assert.equal(isObservableSlackMessage(botOnly), true);
  assert.equal(isRoutableSlackMessage(botOnly), false);

  const human = {
    type: 'message',
    channel: 'C1',
    ts: '2.0',
    text: 'hi',
    user: 'U1',
  };
  assert.equal(isObservableSlackMessage(human), true);
  assert.equal(isRoutableSlackMessage(human), true);

  const noActor = {
    type: 'message',
    channel: 'C1',
    ts: '3.0',
    text: 'orphan',
  };
  assert.equal(isObservableSlackMessage(noActor), false);
});

test('observe assigns monotonic ordinals and updates the conversation index', async () => {
  await withAgentStore(async (store) => {
    const a = await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '100.001',
      text: 'hello',
      userId: 'U1',
    });
    const b = await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '100.002',
      text: 'world',
      userId: 'U2',
    });
    assert.equal(a.appended, true);
    assert.equal(b.appended, true);
    if (!a.appended || !b.appended) return;
    assert.equal(a.entry.ordinal, 1);
    assert.equal(b.entry.ordinal, 2);
    assert.equal(a.entry.surfaceId, 'slack:T1:C1');
    assert.equal(a.entry.eventId, 'slack:T1:C1:100.001');

    const index = await store.getIndex('slack:T1:C1');
    assert.deepEqual(
      {
        tailOrdinal: index?.tailOrdinal,
        lastEventId: index?.lastEventId,
        lastMessageTs: index?.lastMessageTs,
        surfaceId: index?.surfaceId,
      },
      {
        tailOrdinal: 2,
        lastEventId: 'slack:T1:C1:100.002',
        lastMessageTs: '100.002',
        surfaceId: 'slack:T1:C1',
      },
    );

    const journal = await store.readJournal('slack:T1:C1');
    assert.equal(journal.length, 2);
    assert.deepEqual(journal.map((row) => row.text), ['hello', 'world']);
  });
});

test('observe dedupes stable Slack event ids within a conversation', async () => {
  await withAgentStore(async (store) => {
    const first = await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '200.001',
      text: 'once',
      userId: 'U1',
    });
    const second = await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '200.001',
      text: 'once-again',
      userId: 'U1',
    });
    assert.equal(first.appended, true);
    assert.equal(second.appended, false);
    if (second.appended) return;
    assert.equal(second.reason, 'duplicate');

    const index = await store.getIndex('slack:T1:C1');
    assert.equal(index?.tailOrdinal, 1);
    const journal = await store.readJournal('slack:T1:C1');
    assert.equal(journal.length, 1);
    assert.equal(journal[0]?.text, 'once');
  });
});

test('stale index after journal append is repaired on replay; next ordinal advances', async () => {
  // Milo red control: append ordinal 1 → restore stale tail 0 → replay → index
  // repair → next event ordinal 2 (never [1,1]).
  await withAgentStore(async (store) => {
    const surfaceId = 'slack:T1:C1';
    const first = await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '700.001',
      text: 'alpha',
      userId: 'U1',
    });
    assert.equal(first.appended, true);
    if (!first.appended) return;
    assert.equal(first.entry.ordinal, 1);

    // Simulate crash: journal has row 1, index restored to empty/stale tail 0.
    await store.writeIndexForTest({
      lastEventId: '',
      lastMessageTs: '',
      surfaceId,
      tailOrdinal: 0,
      updatedAt: new Date(0).toISOString(),
    });
    assert.equal(await store.getIndex(surfaceId), undefined);

    const replay = await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '700.001',
      text: 'alpha',
      userId: 'U1',
    });
    assert.equal(replay.appended, false);
    if (replay.appended) return;
    assert.equal(replay.reason, 'duplicate');

    const repaired = await store.getIndex(surfaceId);
    assert.equal(repaired?.tailOrdinal, 1);
    assert.equal(repaired?.lastEventId, 'slack:T1:C1:700.001');

    const next = await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '700.002',
      text: 'beta',
      userId: 'U2',
    });
    assert.equal(next.appended, true);
    if (!next.appended) return;
    assert.equal(next.entry.ordinal, 2);

    const journal = await store.readJournal(surfaceId);
    assert.deepEqual(journal.map((r) => r.ordinal), [1, 2]);
    assert.deepEqual(journal.map((r) => r.text), ['alpha', 'beta']);
  });
});

test('cursor reads and a repeat of the newest event read only the newest journal rows', async () => {
  await withAgentStore(async (store, agentId) => {
    const surfaceId = 'slack:T1:C1';
    const first = await store.observe({ teamId: 'T1', channelId: 'C1', messageTs: '1000.000001', text: 'seed', userId: 'U1' });
    assert.equal(first.appended, true);
    if (!first.appended) return;

    // 1,500 rows of about 2KB, fewer than the 2,000-row dedupe window.
    const rows = Array.from({ length: 1_500 }, (_, index) => {
      const messageTs = `${1000 + index}.000001`;
      return { ...first.entry, eventId: `slack:T1:C1:${messageTs}`, messageTs, ordinal: index + 1, text: 'x'.repeat(2_000) };
    });
    const journalPath = join(observedConversationsDir(agentId), `${observedConversationFileStem(surfaceId)}.jsonl`);
    await writeFile(journalPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
    const newest = rows.at(-1)!;
    await store.writeIndexForTest({
      lastEventId: newest.eventId,
      lastMessageTs: newest.messageTs,
      surfaceId,
      tailOrdinal: newest.ordinal,
      updatedAt: new Date().toISOString(),
    });
    const fileBytes = (await stat(journalPath)).size;

    const realOpen = fsPromises.open;
    const realReadFile = fsPromises.readFile;
    let journalBytes = 0;
    const isJournal = (path: unknown) => String(path).endsWith('.jsonl');
    fsPromises.open = (async (...args: Parameters<typeof realOpen>) => {
      const handle = await realOpen(...args);
      if (!isJournal(args[0])) return handle;
      const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>;
      (handle as unknown as { read: typeof read }).read = async (...readArgs: unknown[]) => {
        const result = await read(...readArgs);
        journalBytes += result.bytesRead;
        return result;
      };
      return handle;
    }) as typeof realOpen;
    fsPromises.readFile = (async (...args: Parameters<typeof realReadFile>) => {
      const data = await realReadFile(...args);
      if (isJournal(args[0])) journalBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      return data;
    }) as typeof realReadFile;
    syncBuiltinESMExports();

    const measure = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
      journalBytes = 0;
      const result = await run();
      assert.ok(journalBytes < fileBytes / 10, `${label} read ${journalBytes} bytes of a ${fileBytes}-byte journal`);
      return result;
    };
    try {
      const advanced = await measure('advanceCursor', () => store.advanceCursor({
        expected: { status: 'absent' },
        nextDeliveredOrdinal: 1_498,
        surfaceId,
      }));
      assert.equal(advanced.advanced, true);
      const index = await measure('getIndexReconciled', () => store.getIndexReconciled(surfaceId));
      assert.equal(index?.tailOrdinal, 1_500);
      const snapshot = await measure('readCursorDeliverySnapshot', () => store.readCursorDeliverySnapshot(surfaceId, {
        afterOrdinal: 1_498,
        limit: 5_000,
      }));
      assert.equal(snapshot.capturedTailOrdinal, 1_500);
      assert.deepEqual(snapshot.candidates.map((row) => row.ordinal), [1_499, 1_500]);
      const repeat = await measure('observe (repeat of the newest event)', () => store.observe({
        teamId: 'T1',
        channelId: 'C1',
        messageTs: newest.messageTs,
        text: 'again',
        userId: 'U1',
      }));
      assert.equal(repeat.appended, false);
    } finally {
      fsPromises.open = realOpen;
      fsPromises.readFile = realReadFile;
      syncBuiltinESMExports();
    }
    assert.equal((await readFile(journalPath, 'utf8')).split('\n').filter(Boolean).length, 1_500);
  });
});

test('cursor snapshot and dedupe hold when the index is ahead of the journal', async () => {
  await withAgentStore(async (store) => {
    const surfaceId = 'slack:T1:C1';
    for (let i = 1; i <= 5; i += 1) {
      await store.observe({ teamId: 'T1', channelId: 'C1', messageTs: `300.00${i}`, text: `row-${i}`, userId: 'U1' });
    }
    // Rows 6–8 are missing from the journal, so ordinals will have a gap.
    await store.writeIndexForTest({
      lastEventId: 'slack:T1:C1:300.008',
      lastMessageTs: '300.008',
      surfaceId,
      tailOrdinal: 8,
      updatedAt: new Date().toISOString(),
    });
    const next = await store.observe({ teamId: 'T1', channelId: 'C1', messageTs: '300.009', text: 'row-9', userId: 'U1' });
    assert.equal(next.appended, true);
    if (!next.appended) return;
    assert.equal(next.entry.ordinal, 9);

    const ordinals = async (afterOrdinal: number, limit: number) => {
      const snapshot = await store.readCursorDeliverySnapshot(surfaceId, { afterOrdinal, limit });
      assert.equal(snapshot.capturedTailOrdinal, 9);
      return snapshot.candidates.map((row) => row.ordinal);
    };
    assert.deepEqual(await ordinals(0, 100), [1, 2, 3, 4, 5, 9]);
    assert.deepEqual(await ordinals(3, 100), [4, 5, 9]);
    assert.deepEqual(await ordinals(3, 2), [5, 9]);
    assert.deepEqual(await ordinals(5, 100), [9]);
    assert.deepEqual(await ordinals(9, 100), []);

    // A row older than the newest is still found in the dedupe window.
    const repeat = await store.observe({ teamId: 'T1', channelId: 'C1', messageTs: '300.002', text: 'again', userId: 'U1' });
    assert.equal(repeat.appended, false);
    assert.equal((await store.readJournal(surfaceId)).length, 6);
  });
});

test('top-level and thread observations are independent ordinal sequences', async () => {
  await withAgentStore(async (store) => {
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '10.0',
      text: 'root',
      userId: 'U1',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '11.0',
      threadTs: '10.0',
      text: 'reply',
      userId: 'U2',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '12.0',
      text: 'root-2',
      userId: 'U3',
    });

    const channel = await store.getIndex('slack:T1:C1');
    const thread = await store.getIndex('slack:T1:C1:thread:10.0');
    assert.equal(channel?.tailOrdinal, 2);
    assert.equal(thread?.tailOrdinal, 1);
    assert.equal((await store.readJournal('slack:T1:C1')).map((r) => r.text).join(','), 'root,root-2');
    assert.equal((await store.readJournal('slack:T1:C1:thread:10.0'))[0]?.text, 'reply');
  });
});

test('DM conversations are journaled under the DM surface id', async () => {
  await withAgentStore(async (store) => {
    const result = await store.observe({
      teamId: 'T9',
      channelId: 'D9',
      messageTs: '300.1',
      text: 'private',
      userId: 'U9',
    });
    assert.equal(result.appended, true);
    if (!result.appended) return;
    assert.equal(result.entry.surfaceId, 'slack:T9:D9');
    assert.equal((await store.getIndex('slack:T9:D9'))?.tailOrdinal, 1);
  });
});

test('userless bot_message is journaled with botId actor (no userId)', async () => {
  await withAgentStore(async (store) => {
    const result = await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '800.1',
      text: 'bot says hi',
      botId: 'B99',
    });
    assert.equal(result.appended, true);
    if (!result.appended) return;
    assert.equal(result.entry.botId, 'B99');
    assert.equal(result.entry.userId, undefined);
    assert.equal(result.entry.ordinal, 1);
  });
});

test('file-only observation stores file descriptors (readable delta marker)', async () => {
  await withAgentStore(async (store) => {
    const result = await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '900.1',
      text: '',
      userId: 'U1',
      files: [{ id: 'F1', name: 'notes.pdf', mimetype: 'application/pdf' }],
    });
    assert.equal(result.appended, true);
    if (!result.appended) return;
    assert.equal(result.entry.text, '');
    assert.deepEqual(result.entry.files, [
      { id: 'F1', name: 'notes.pdf', mimetype: 'application/pdf' },
    ]);
  });
});

test('delivered cursor: confirmed-absent vs ordinal-0; CAS + beyond_tail are fail-closed', async () => {
  await withAgentStore(async (store) => {
    const surfaceId = 'slack:T1:C1';

    // Never written → confirmed absent (distinct from present@0).
    const absent = await store.getCursor(surfaceId);
    assert.equal(absent.status, 'absent');

    // No journal: advance to 1 (or any N>0) is beyond_tail.
    const skip = await store.advanceCursor({
      surfaceId,
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 1,
    });
    assert.equal(skip.advanced, false);
    if (skip.advanced) return;
    assert.equal(skip.reason, 'beyond_tail');
    assert.equal(skip.tailOrdinal, 0);
    assert.equal((await store.getCursor(surfaceId)).status, 'absent');

    // Only allowed no-journal establishment: present@0.
    const toZero = await store.advanceCursor({
      surfaceId,
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 0,
    });
    assert.equal(toZero.advanced, true);
    if (!toZero.advanced) return;
    assert.equal(toZero.cursor.status, 'present');
    assert.equal(toZero.cursor.deliveredOrdinal, 0);

    const present0 = await store.getCursor(surfaceId);
    assert.equal(present0.status, 'present');
    if (present0.status !== 'present') return;
    assert.equal(present0.deliveredOrdinal, 0);

    // Wrong expected → cas_mismatch
    const mismatch = await store.advanceCursor({
      surfaceId,
      expected: { status: 'absent' },
      nextDeliveredOrdinal: 0,
    });
    assert.equal(mismatch.advanced, false);
    if (mismatch.advanced) return;
    assert.equal(mismatch.reason, 'cas_mismatch');

    // Seed journal tail=2, then advance 0 → 2 is allowed.
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'a',
      userId: 'U1',
    });
    await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '2.0',
      text: 'b',
      userId: 'U2',
    });
    assert.equal((await store.getIndex(surfaceId))?.tailOrdinal, 2);

    const toTwo = await store.advanceCursor({
      surfaceId,
      expected: { status: 'present', deliveredOrdinal: 0 },
      nextDeliveredOrdinal: 2,
      lastDeliveredEventId: 'slack:T1:C1:2.0',
      lastDeliveredMessageTs: '2.0',
    });
    assert.equal(toTwo.advanced, true);
    if (!toTwo.advanced) return;
    assert.equal(toTwo.cursor.deliveredOrdinal, 2);
    assert.equal(toTwo.cursor.lastDeliveredEventId, 'slack:T1:C1:2.0');

    // Past tail rejected
    const past = await store.advanceCursor({
      surfaceId,
      expected: { status: 'present', deliveredOrdinal: 2 },
      nextDeliveredOrdinal: 99,
    });
    assert.equal(past.advanced, false);
    if (past.advanced) return;
    assert.equal(past.reason, 'beyond_tail');
    assert.equal(past.tailOrdinal, 2);

    // Regression blocked
    const reg = await store.advanceCursor({
      surfaceId,
      expected: { status: 'present', deliveredOrdinal: 2 },
      nextDeliveredOrdinal: 1,
    });
    assert.equal(reg.advanced, false);
    if (reg.advanced) return;
    assert.equal(reg.reason, 'regression');
    assert.equal((await store.getCursor(surfaceId) as { deliveredOrdinal?: number }).deliveredOrdinal, 2);
  });
});

test('continuity degrades on write failure and persists across store re-instantiation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-obs-cont-'));
  try {
    await writeAgentConfigs(stateDir, [defaultAgentConfig('anima')]);
    // Agent home exists; block only the journal directory (file where a dir must be).
    // Continuity lives as a sibling path so it remains writable + queryable.
    const agentHome = join(stateDir, 'agents', 'anima');
    await mkdir(agentHome, { recursive: true });
    await writeFile(join(agentHome, 'observed-conversations'), 'not-a-dir', 'utf8');
    await withAnimaHome(stateDir, async () => {
      const soft = await observeObservableSlackMessage({
        agentId: 'anima',
        envelope: { team_id: 'T1' },
        event: {
          channel: 'C1',
          text: 'x',
          ts: '1.0',
          type: 'message',
          user: 'U1',
        },
      });
      assert.equal(soft, undefined);

      // Continuity is queryable and survives a new store instance (restart).
      const storeA = new ObservedConversationStore('anima');
      const contA = await storeA.getContinuity();
      assert.equal(contA.status, 'degraded');
      assert.ok(contA.lastFailureAt);
      assert.ok(contA.lastFailureMessage);

      const storeB = new ObservedConversationStore('anima');
      const contB = await storeB.getContinuity();
      assert.equal(contB.status, 'degraded');
      assert.equal(contB.lastFailureAt, contA.lastFailureAt);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('degraded continuity is sticky across later successful observes (no auto-clear)', async () => {
  // Milo red control: failure → later success → new store instance still degraded.
  // Cut (a) has no public repair API — only getContinuity + degrade.
  await withAgentStore(async (store) => {
    await store.markDegraded({ message: 'prior gap', surfaceId: 'slack:T1:C1' });
    assert.equal((await store.getContinuity()).status, 'degraded');

    const observed = await store.observe({
      teamId: 'T1',
      channelId: 'C1',
      messageTs: '1.0',
      text: 'later success does not repair the gap',
      userId: 'U1',
    });
    assert.equal(observed.appended, true);

    const after = await store.getContinuity();
    assert.equal(after.status, 'degraded');
    assert.equal(after.lastFailureMessage, 'prior gap');

    // Fresh store instance (restart) still reads degraded.
    const restarted = new ObservedConversationStore('anima');
    assert.equal((await restarted.getContinuity()).status, 'degraded');
    assert.equal((await restarted.getContinuity()).lastFailureMessage, 'prior gap');
  });
});

test('observe write failure surfaces when throwOnError is set', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-obs-fail-'));
  try {
    await writeAgentConfigs(stateDir, [defaultAgentConfig('anima')]);
    const agentHome = join(stateDir, 'agents', 'anima');
    await mkdir(agentHome, { recursive: true });
    await writeFile(join(agentHome, 'observed-conversations'), 'not-a-dir', 'utf8');
    await withAnimaHome(stateDir, async () => {
      await assert.rejects(
        observeObservableSlackMessage({
          agentId: 'anima',
          envelope: { team_id: 'T1' },
          event: {
            channel: 'C1',
            text: 'x',
            ts: '1.0',
            type: 'message',
            user: 'U1',
          },
          throwOnError: true,
        }),
      );
      const soft = await observeObservableSlackMessage({
        agentId: 'anima',
        envelope: { team_id: 'T1' },
        event: {
          channel: 'C1',
          text: 'x',
          ts: '1.0',
          type: 'message',
          user: 'U1',
        },
      });
      assert.equal(soft, undefined);
      assert.equal((await new ObservedConversationStore('anima').getContinuity()).status, 'degraded');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('journal rotation keeps retained segments recoverable; index stays monotonic', async () => {
  await withAgentStore(async (store, agentId) => {
    for (let i = 0; i < 30; i += 1) {
      const result = await store.observe({
        teamId: 'T1',
        channelId: 'Crot',
        messageTs: `500.${String(i).padStart(6, '0')}`,
        text: `line-${i}-${'x'.repeat(80)}`,
        userId: 'U1',
      });
      assert.equal(result.appended, true);
    }

    const index = await store.getIndex('slack:T1:Crot');
    assert.equal(index?.tailOrdinal, 30);
    assert.equal(index?.lastMessageTs, '500.000029');

    const retained = await store.readJournal('slack:T1:Crot', { limit: 1000 });
    assert.ok(retained.length >= 1, 'expected retained journal rows after rotation');
    assert.ok(retained.length < 30, 'maxArchives should prune some early rows');
    assert.equal(retained[retained.length - 1]?.ordinal, 30);
    for (let i = 1; i < retained.length; i += 1) {
      assert.equal(retained[i]!.ordinal, retained[i - 1]!.ordinal + 1);
    }

    const stem = observedConversationFileStem('slack:T1:Crot');
    const archiveDir = join(observedConversationsDir(agentId), 'archive', stem);
    const archives = await readdir(archiveDir).catch(() => [] as string[]);
    assert.ok(archives.length >= 1, `expected rotated archives, got ${archives.join(',')}`);
    assert.ok(archives.length <= 4, `maxArchives=4, got ${archives.length}`);
  }, { maxBytes: 800, maxArchives: 4 });
});

test('journal rotation with high maxArchives recovers full ordinal sequence', async () => {
  await withAgentStore(async (store) => {
    for (let i = 0; i < 20; i += 1) {
      const result = await store.observe({
        teamId: 'T1',
        channelId: 'Cfull',
        messageTs: `600.${String(i).padStart(6, '0')}`,
        text: `full-${i}-${'y'.repeat(60)}`,
        userId: 'U1',
      });
      assert.equal(result.appended, true);
    }
    const all = await store.readJournal('slack:T1:Cfull', { limit: 1000 });
    assert.equal(all.length, 20);
    assert.equal(all[0]?.ordinal, 1);
    assert.equal(all[19]?.ordinal, 20);
    assert.equal((await store.getIndex('slack:T1:Cfull'))?.tailOrdinal, 20);
  }, { maxBytes: 600, maxArchives: 40 });
});

test('readJournal afterOrdinal and limit slice by conversation ordinal', async () => {
  await withAgentStore(async (store) => {
    for (let i = 1; i <= 5; i += 1) {
      await store.observe({
        teamId: 'T1',
        channelId: 'C2',
        messageTs: `60${i}.0`,
        text: `m${i}`,
        userId: 'U1',
      });
    }
    const mid = await store.readJournal('slack:T1:C2', { afterOrdinal: 2, limit: 2 });
    assert.deepEqual(mid.map((r) => r.text), ['m4', 'm5']);
  });
});

test('file stem is filesystem-safe for surface ids', () => {
  const stem = observedConversationFileStem('slack:T1:C1:thread:1.0');
  assert.equal(stem.includes('/'), false);
  assert.equal(stem.includes(':'), false);
  assert.ok(stem.length > 0);
});

// --- Ingress-level (handleSlackEvent) ---

test('ingress: ignored human post (unfollowed thread reply) is journaled before wake filter', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-obs-ingress-human-'));
  try {
    await writeAgentConfigs(stateDir, [defaultAgentConfig('anima')]);
    await withAnimaHome(stateDir, async () => {
      // Thread reply with no thread follow → not_addressed for wake; still observed.
      // (Top-level channel posts auto channel_follow in this runtime.)
      await invokeHandleSlackEvent({
        agentId: 'anima',
        event: {
          type: 'message',
          channel: 'C99',
          channel_type: 'channel',
          text: 'noise in unfollowed thread',
          ts: '400.002',
          thread_ts: '400.001',
          user: 'U99',
        },
      });

      const store = new ObservedConversationStore('anima');
      const surfaceId = 'slack:T1:C99:thread:400.001';
      const index = await store.getIndex(surfaceId);
      assert.equal(index?.tailOrdinal, 1);
      assert.equal(
        (await store.readJournal(surfaceId))[0]?.text,
        'noise in unfollowed thread',
      );
      // Not wake-queued (no thread follow / mention).
      const queued = await new WakeQueueService('anima').list();
      assert.equal(queued.length, 0);
      assert.equal((await store.getContinuity()).status, 'ok');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('ingress: userless bot_message is journaled; not routable for wake', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-obs-ingress-bot-'));
  try {
    await writeAgentConfigs(stateDir, [defaultAgentConfig('anima')]);
    await withAnimaHome(stateDir, async () => {
      await invokeHandleSlackEvent({
        agentId: 'anima',
        event: {
          type: 'message',
          subtype: 'bot_message',
          channel: 'C50',
          text: 'integration bot chatter',
          ts: '410.001',
          bot_id: 'B-integration',
          // no user
        },
      });

      const store = new ObservedConversationStore('anima');
      const rows = await store.readJournal('slack:T1:C50');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.botId, 'B-integration');
      assert.equal(rows[0]?.userId, undefined);
      assert.equal(rows[0]?.text, 'integration bot chatter');
      assert.equal((await store.getIndex('slack:T1:C50'))?.tailOrdinal, 1);
      assert.equal((await new WakeQueueService('anima').list()).length, 0);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('ingress: observation failure marks queryable degraded continuity', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-obs-ingress-fail-'));
  try {
    await writeAgentConfigs(stateDir, [defaultAgentConfig('anima')]);
    const agentHome = join(stateDir, 'agents', 'anima');
    await mkdir(agentHome, { recursive: true });
    await writeFile(join(agentHome, 'observed-conversations'), 'not-a-dir', 'utf8');
    await withAnimaHome(stateDir, async () => {
      // Ingress must not throw; continuity must be queryable after.
      await invokeHandleSlackEvent({
        agentId: 'anima',
        event: {
          type: 'message',
          channel: 'C1',
          text: 'will fail to journal',
          ts: '420.001',
          user: 'U1',
        },
      });

      const cont = await new ObservedConversationStore('anima').getContinuity();
      assert.equal(cont.status, 'degraded');
      assert.ok(cont.lastFailureMessage);
      assert.ok(cont.lastFailureAt);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('observeSlackEventAtIngress skips non-observable subtypes', async () => {
  await withAgentStore(async () => {
    const result = await observeSlackEventAtIngress({
      agentId: 'anima',
      envelope: { team_id: 'T1' },
      event: {
        type: 'message',
        subtype: 'message_changed',
        channel: 'C1',
        ts: '1.0',
        user: 'U1',
        text: 'edit',
      },
    });
    assert.equal(result, undefined);
  });
});
