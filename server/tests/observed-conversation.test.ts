import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { observeRoutableSlackMessage } from '../inbox/observed-conversation.js';
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
  // Parent message of a thread stays on the channel surface.
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

test('observeRoutableSlackMessage records events that would be ignored for wake', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-obs-ignore-'));
  try {
    await writeAgentConfigs(stateDir, [defaultAgentConfig('anima')]);
    await withAnimaHome(stateDir, async () => {
      // Channel message with no mention / follow — still observed.
      const result = await observeRoutableSlackMessage({
        agentId: 'anima',
        envelope: { team_id: 'T1' },
        event: {
          channel: 'C99',
          channel_type: 'channel',
          text: 'noise in channel',
          ts: '400.001',
          type: 'message',
          user: 'U99',
        },
        throwOnError: true,
      });
      assert.equal(result?.appended, true);
      const store = new ObservedConversationStore('anima');
      const index = await store.getIndex('slack:T1:C99');
      assert.equal(index?.tailOrdinal, 1);
      assert.equal((await store.readJournal('slack:T1:C99'))[0]?.text, 'noise in channel');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('journal rotation keeps retained segments recoverable; index stays monotonic', async () => {
  // With a small maxBytes, rotation produces multiple archives. maxArchives caps
  // retention (oldest pruned); readAll recovers live + retained archives only.
  // The index still tracks the full ordinal sequence across rotations.
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
    // Retained rows are a contiguous suffix of the ordinal sequence.
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

test('observe write failure surfaces when throwOnError is set', async () => {
  // Invalid agent id path still constructs, but we can force failure by using a
  // non-writable anima home after teardown — simpler: spy via broken channel of
  // empty team that still writes. Instead assert soft-fail path returns undefined
  // without throw when the store path cannot be created under a file-as-home.
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-obs-fail-'));
  const blocker = join(stateDir, 'agents');
  try {
    // Create a FILE where the agents directory must live → writes fail.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(stateDir, { recursive: true });
    await writeFile(blocker, 'not-a-dir', 'utf8');
    await withAnimaHome(stateDir, async () => {
      await assert.rejects(
        observeRoutableSlackMessage({
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
      const soft = await observeRoutableSlackMessage({
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
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('file stem is filesystem-safe for surface ids', () => {
  const stem = observedConversationFileStem('slack:T1:C1:thread:1.0');
  assert.equal(stem.includes('/'), false);
  assert.equal(stem.includes(':'), false);
  assert.ok(stem.length > 0);
});
