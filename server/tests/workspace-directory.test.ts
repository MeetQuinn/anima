import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebClient } from '@slack/web-api';

import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';
import {
  getSlackWorkspaceDirectoryStore,
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

async function seedCache(teamId: string, file: Partial<SlackWorkspaceDirectoryFile>): Promise<void> {
  await getSlackWorkspaceDirectoryStore(teamId).update((cache) => ({
    ...cache,
    teamId,
    channels: file.channels ?? [],
    ...(file.channelsSyncedAt ? { channelsSyncedAt: file.channelsSyncedAt } : {}),
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
        channels: [{ id: 'C-1', name: 'one', is_member: true } as SlackConversationInfo],
        channelsSyncedAt: nowIso(),
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({ client: countingClient([], counter), teamId });

      const channels = await service.getMemberConversations();

      assert.equal(counter.calls, 0, 'fresh cache must not call conversations.list');
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
      assert.ok(cache.channelsSyncedAt, 'cold fetch stamps channelsSyncedAt');
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
        channels: [{ id: 'C-old', name: 'old', is_member: true } as SlackConversationInfo],
        channelsSyncedAt: STALE_ISO,
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

test('concurrent stale reads trigger only one background refresh', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-dedupe-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-dedupe';
      await seedCache(teamId, {
        channels: [{ id: 'C-old', name: 'old', is_member: true } as SlackConversationInfo],
        channelsSyncedAt: STALE_ISO,
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
