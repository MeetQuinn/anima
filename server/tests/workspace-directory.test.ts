import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebClient } from '@slack/web-api';

import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';
import {
  getSlackWorkspaceDirectoryStore,
  type SlackDirectoryUser,
  type SlackWorkspaceDirectoryFile,
} from '../storage/schema/cache.js';
import type { SlackConversationInfo } from '../slack/slack.helper.js';
import { nowIso } from '../ids.js';
import { withAnimaHome } from './anima-home.js';

// A WebClient whose conversations.list returns a fixed set and counts how many
// times Slack was actually hit, so we can prove the hot path stays off the wire.
function countingClient(channels: SlackConversationInfo[], counter: { calls: number }): WebClient {
  return {
    conversations: {
      list: async () => {
        counter.calls += 1;
        return { channels, ok: true };
      },
    },
  } as unknown as WebClient;
}

const STALE_ISO = '2000-01-01T00:00:00.000Z';

const FULL_MEMBER_TYPES = 'public_channel,private_channel,mpim';

async function seedCache(teamId: string, file: Partial<SlackWorkspaceDirectoryFile>): Promise<void> {
  await getSlackWorkspaceDirectoryStore(teamId).update((cache) => ({
    ...cache,
    teamId,
    channels: file.channels ?? [],
    users: file.users ?? [],
    ...(file.channelsFullSyncAt ? { channelsFullSyncAt: file.channelsFullSyncAt } : {}),
    ...(file.channelsFullSyncTypes ? { channelsFullSyncTypes: file.channelsFullSyncTypes } : {}),
    ...(file.usersFullSyncAt ? { usersFullSyncAt: file.usersFullSyncAt } : {}),
  }));
}

async function waitForChannelIds(teamId: string, ids: string[], timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cache = await getSlackWorkspaceDirectoryStore(teamId).read();
    const have = cache.channels.map((c) => c.id).sort();
    if (have.length === ids.length && have.every((id, i) => id === [...ids].sort()[i])) return;
    if (Date.now() >= deadline) {
      throw new Error(`cache channels ${JSON.stringify(have)} never became ${JSON.stringify(ids)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('getMemberConversations serves a fresh cache without hitting Slack', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-fresh-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-fresh';
      await seedCache(teamId, {
        channels: [{ id: 'C-1', isMember: true, name: 'one', syncedAt: nowIso() }],
        channelsFullSyncAt: nowIso(),
        channelsFullSyncTypes: FULL_MEMBER_TYPES,
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({ client: countingClient([], counter), teamId });

      const channels = await service.getMemberConversations();

      assert.equal(counter.calls, 0, 'fresh cache with full type coverage must not call conversations.list');
      assert.deepEqual(channels.map((c) => c.id), ['C-1']);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('getMemberConversations on a cold cache hits Slack once and populates the cache', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-cold-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-cold';
      const live: SlackConversationInfo[] = [
        { id: 'C-live', name: 'live', is_member: true } as SlackConversationInfo,
        { id: 'C-other', name: 'other', is_member: false } as SlackConversationInfo,
      ];
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({ client: countingClient(live, counter), teamId });

      const channels = await service.getMemberConversations();

      assert.equal(counter.calls, 1, 'cold cache must fetch once');
      assert.deepEqual(channels.map((c) => c.id), ['C-live'], 'only member channels returned');
      const cache = await getSlackWorkspaceDirectoryStore(teamId).read();
      assert.deepEqual(cache.channels.map((c) => c.id).sort(), ['C-live', 'C-other']);
      assert.ok(cache.channelsFullSyncAt, 'cold fetch stamps channelsFullSyncAt');
      assert.equal(cache.channelsFullSyncTypes, 'public_channel,private_channel,mpim', 'cold fetch records the type coverage');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('getMemberConversations serves a stale cache immediately and refreshes in the background', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-stale-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-stale';
      await seedCache(teamId, {
        channels: [{ id: 'C-old', isMember: true, name: 'old', syncedAt: STALE_ISO }],
        channelsFullSyncAt: STALE_ISO,
        channelsFullSyncTypes: FULL_MEMBER_TYPES,
      });
      const live: SlackConversationInfo[] = [
        { id: 'C-new', name: 'new', is_member: true } as SlackConversationInfo,
      ];
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({ client: countingClient(live, counter), teamId });

      const channels = await service.getMemberConversations();
      assert.deepEqual(channels.map((c) => c.id), ['C-old'], 'stale data is returned immediately');

      await waitForChannelIds(teamId, ['C-new']);
      assert.equal(counter.calls, 1, 'exactly one background refresh ran');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('getMemberConversations does not serve a fresh cache that lacks mpim coverage', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-coverage-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-coverage';
      // A prior channel-name lookup left a FRESH cache, but it was populated with
      // only public/private channels (no mpim). The membership list must not be
      // fooled into treating this narrow-but-fresh snapshot as authoritative.
      await seedCache(teamId, {
        channels: [{ id: 'C-pub', isMember: true, name: 'pub', syncedAt: nowIso() }],
        channelsFullSyncAt: nowIso(),
        channelsFullSyncTypes: 'public_channel,private_channel',
      });
      const live: SlackConversationInfo[] = [
        { id: 'C-pub', name: 'pub', is_member: true } as SlackConversationInfo,
        { id: 'G-mpdm', name: 'mpdm-team', is_mpim: true } as SlackConversationInfo,
      ];
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({ client: countingClient(live, counter), teamId });

      const channels = await service.getMemberConversations();

      assert.equal(counter.calls, 1, 'narrow-but-fresh cache must trigger a widening fetch, not be served as-is');
      assert.ok(
        channels.some((c) => c.id === 'G-mpdm' && c.isMpim),
        'the mpim member row is present after the widening fetch',
      );
      const cache = await getSlackWorkspaceDirectoryStore(teamId).read();
      assert.ok(cache.channelsFullSyncTypes?.includes('mpim'), 'cache coverage is widened to include mpim');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('concurrent stale reads trigger only one background refresh', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-dedupe-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-dedupe';
      await seedCache(teamId, {
        channels: [{ id: 'C-old', isMember: true, name: 'old', syncedAt: STALE_ISO }],
        channelsFullSyncAt: STALE_ISO,
        channelsFullSyncTypes: FULL_MEMBER_TYPES,
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        client: countingClient([{ id: 'C-new', name: 'new', is_member: true } as SlackConversationInfo], counter),
        teamId,
      });

      await Promise.all(Array.from({ length: 5 }, () => service.getMemberConversations()));
      await waitForChannelIds(teamId, ['C-new']);

      assert.equal(counter.calls, 1, 'in-flight guard collapses concurrent refreshes to one');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('directory events do not restamp collection full-sync timestamps', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-event-stamp-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-event-stamp';
      await seedCache(teamId, {
        channels: [{ id: 'C-old', isMember: true, name: 'old', syncedAt: STALE_ISO }],
        channelsFullSyncAt: STALE_ISO,
        channelsFullSyncTypes: FULL_MEMBER_TYPES,
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        client: countingClient([{ id: 'C-new', name: 'new', is_member: true } as SlackConversationInfo], counter),
        teamId,
      });

      await service.applyEvent({
        channel: { id: 'C-event', name: 'event', is_member: true } as SlackConversationInfo,
        team: teamId,
        type: 'channel_created',
      });
      const afterEvent = await getSlackWorkspaceDirectoryStore(teamId).read();
      assert.equal(afterEvent.channelsFullSyncAt, STALE_ISO, 'event upsert must not restamp full-sync time');

      const channels = await service.getMemberConversations();
      assert.deepEqual(channels.map((channel) => channel.id).sort(), ['C-event', 'C-old']);
      await waitForChannelIds(teamId, ['C-new']);
      assert.equal(counter.calls, 1, 'stale full-sync timestamp still triggers a full refresh after an event');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('stale entry reads serve local data immediately and single-flight the refresh', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-entry-stale-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-entry-stale';
      await seedCache(teamId, {
        users: [{ id: 'U123', name: 'old', syncedAt: STALE_ISO }],
      });
      const deferred = deferredValue();
      let calls = 0;
      const client = {
        users: {
          info: async () => {
            calls += 1;
            await deferred.promise;
            return { ok: true, user: { id: 'U123', name: 'new' } };
          },
        },
      } as unknown as WebClient;
      const service = new SlackWorkspaceDirectoryService({ client, teamId });

      const [first, second] = await Promise.all([service.getUser('U123'), service.getUser('U123')]);
      assert.equal(first?.name, 'old');
      assert.equal(second?.name, 'old');
      assert.equal(calls, 1, 'concurrent stale entry reads share one background users.info call');

      deferred.resolve();
      await waitForUser(teamId, 'U123', (user) => user.name === 'new');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('failed entry lookup is retried after the negative ttl and never persisted', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-negative-'));
  const realNow = Date.now;
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-negative';
      let now = realNow();
      Date.now = () => now;
      let calls = 0;
      const client = {
        users: {
          info: async () => {
            calls += 1;
            if (calls === 1) throw new Error('transient_slack_error');
            return { ok: true, user: { id: 'U404', name: 'found' } };
          },
        },
      } as unknown as WebClient;
      const service = new SlackWorkspaceDirectoryService({ client, teamId });

      await assert.rejects(() => service.getUser('U404'), /transient_slack_error/);
      assert.equal(await service.getUser('U404'), undefined);
      assert.equal(calls, 1, 'negative lookup suppresses immediate retry');
      assert.deepEqual((await getSlackWorkspaceDirectoryStore(teamId).read()).users, [], 'negative result is not written to disk');

      now += 61_000;
      assert.equal((await service.getUser('U404'))?.name, 'found');
      assert.equal(calls, 2, 'lookup retries after the 60s negative ttl');
    });
  } finally {
    Date.now = realNow;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('cold v2 start ignores an existing old directory.json and full-syncs', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-v2-cold-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-v2-cold';
      const oldDir = join(stateDir, 'cache', 'slack', 'teams', teamId);
      await mkdir(oldDir, { recursive: true });
      await writeFile(join(oldDir, 'directory.json'), JSON.stringify({
        channels: [{ id: 'C-old', name: 'old', is_member: true }],
        channelsSyncedAt: nowIso(),
        channelsSyncedTypes: FULL_MEMBER_TYPES,
        teamId,
        users: [],
      }));
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        client: countingClient([{ id: 'C-new', name: 'new', is_member: true } as SlackConversationInfo], counter),
        teamId,
      });

      const channels = await service.getMemberConversations();

      assert.equal(counter.calls, 1, 'old directory.json does not satisfy the v2 replica');
      assert.deepEqual(channels.map((channel) => channel.id), ['C-new']);
      assert.deepEqual((await getSlackWorkspaceDirectoryStore(teamId).read()).channels.map((channel) => channel.id), ['C-new']);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

function deferredValue(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForUser(
  teamId: string,
  userId: string,
  match: (user: SlackDirectoryUser) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const user = (await getSlackWorkspaceDirectoryStore(teamId).read()).users.find((entry) => entry.id === userId);
    if (user && match(user)) return;
    if (Date.now() >= deadline) throw new Error(`cache user ${userId} never matched`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
