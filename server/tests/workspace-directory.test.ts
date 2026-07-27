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
import { waitFor } from './helpers/harness.js';

// A WebClient whose conversations.list returns a fixed set and counts how many
// times Slack was actually hit, so channel-name tests can prove cache behavior.
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

// Membership is bot-relative in Slack. This client models the authoritative
// users.conversations path without allowing shared workspace metadata to answer
// for a different bot identity.
function countingMembershipClient(
  channels: SlackConversationInfo[],
  counter: { calls: number },
  infoById: Record<string, SlackConversationInfo> = {},
): WebClient {
  return {
    conversations: {
      info: async ({ channel }: { channel: string }) => ({
        channel: infoById[channel],
        ok: true,
      }),
      list: async () => ({ channels: [], ok: true }),
    },
    users: {
      conversations: async () => {
        counter.calls += 1;
        return { channels, ok: true };
      },
    },
  } as unknown as WebClient;
}

const STALE_ISO = '2000-01-01T00:00:00.000Z';

const FULL_MEMBER_TYPES = 'public_channel,private_channel,mpim';
const BOT_USER_ID = 'U-bot';

async function seedCache(teamId: string, file: Partial<SlackWorkspaceDirectoryFile>): Promise<void> {
  await getSlackWorkspaceDirectoryStore(teamId).update((cache) => ({
    ...cache,
    teamId,
    channels: file.channels ?? [],
    memberships: file.memberships ?? {},
    users: file.users ?? [],
    ...(file.channelsFullSyncAt ? { channelsFullSyncAt: file.channelsFullSyncAt } : {}),
    ...(file.channelsFullSyncTypes ? { channelsFullSyncTypes: file.channelsFullSyncTypes } : {}),
    ...(file.usersFullSyncAt ? { usersFullSyncAt: file.usersFullSyncAt } : {}),
  }));
}

async function waitForMembership(
  teamId: string,
  botUserId: string,
  ids: string[],
  timeoutMs = 2000,
): Promise<void> {
  const expectedIds = [...ids].sort();
  await waitFor(async () => {
    const cache = await getSlackWorkspaceDirectoryStore(teamId).read();
    const have = [...(cache.memberships[botUserId]?.channelIds ?? [])].sort();
    return have.length === expectedIds.length && have.every((id, i) => id === expectedIds[i]);
  }, { description: `membership ${botUserId} to become ${JSON.stringify(ids)}`, timeoutMs });
}

test('getMemberConversations serves a fresh cache without hitting Slack', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-fresh-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-fresh';
      await seedCache(teamId, {
        channels: [{ id: 'C-1', name: 'one', syncedAt: nowIso() }],
        memberships: {
          [BOT_USER_ID]: {
            channelIds: ['C-1'],
            syncedAt: nowIso(),
            syncedTypes: FULL_MEMBER_TYPES,
          },
        },
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        botUserId: BOT_USER_ID,
        client: countingMembershipClient([], counter),
        teamId,
      });

      const channels = await service.getMemberConversations();

      assert.equal(counter.calls, 0, 'fresh bot-scoped membership cache must not call users.conversations');
      assert.deepEqual(channels.map((c) => c.id), ['C-1']);
      assert.equal(channels[0]?.isMember, true);
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
      ];
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        botUserId: BOT_USER_ID,
        client: countingMembershipClient(live, counter),
        teamId,
      });

      const channels = await service.getMemberConversations();

      assert.equal(counter.calls, 1, 'cold cache must fetch once');
      assert.deepEqual(channels.map((c) => c.id), ['C-live']);
      const cache = await getSlackWorkspaceDirectoryStore(teamId).read();
      assert.deepEqual(cache.channels.map((c) => c.id), ['C-live']);
      assert.equal(cache.channels[0]?.isMember, undefined, 'shared workspace metadata never persists membership');
      assert.deepEqual(cache.memberships[BOT_USER_ID]?.channelIds, ['C-live']);
      assert.equal(cache.memberships[BOT_USER_ID]?.syncedTypes, FULL_MEMBER_TYPES);
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
        channels: [{ id: 'C-old', name: 'old', syncedAt: STALE_ISO }],
        memberships: {
          [BOT_USER_ID]: {
            channelIds: ['C-old'],
            syncedAt: STALE_ISO,
            syncedTypes: FULL_MEMBER_TYPES,
          },
        },
      });
      const live: SlackConversationInfo[] = [
        { id: 'C-new', name: 'new', is_member: true } as SlackConversationInfo,
      ];
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        botUserId: BOT_USER_ID,
        client: countingMembershipClient(live, counter),
        teamId,
      });

      const channels = await service.getMemberConversations();
      assert.deepEqual(channels.map((c) => c.id), ['C-old'], 'stale data is returned immediately');

      await waitForMembership(teamId, BOT_USER_ID, ['C-new']);
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
      // A prior member lookup left a fresh membership snapshot, but it covered
      // only public/private channels (no mpim). The default lookup must widen it.
      await seedCache(teamId, {
        channels: [{ id: 'C-pub', name: 'pub', syncedAt: nowIso() }],
        memberships: {
          [BOT_USER_ID]: {
            channelIds: ['C-pub'],
            syncedAt: nowIso(),
            syncedTypes: 'public_channel,private_channel',
          },
        },
      });
      const live: SlackConversationInfo[] = [
        { id: 'C-pub', name: 'pub', is_member: true } as SlackConversationInfo,
        { id: 'G-mpdm', name: 'mpdm-team', is_mpim: true } as SlackConversationInfo,
      ];
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        botUserId: BOT_USER_ID,
        client: countingMembershipClient(live, counter),
        teamId,
      });

      const channels = await service.getMemberConversations();

      assert.equal(counter.calls, 1, 'narrow-but-fresh cache must trigger a widening fetch, not be served as-is');
      assert.ok(
        channels.some((c) => c.id === 'G-mpdm' && c.isMpim),
        'the mpim member row is present after the widening fetch',
      );
      const cache = await getSlackWorkspaceDirectoryStore(teamId).read();
      assert.ok(cache.memberships[BOT_USER_ID]?.syncedTypes.includes('mpim'), 'membership coverage widens to include mpim');
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
        channels: [{ id: 'C-old', name: 'old', syncedAt: STALE_ISO }],
        memberships: {
          [BOT_USER_ID]: {
            channelIds: ['C-old'],
            syncedAt: STALE_ISO,
            syncedTypes: FULL_MEMBER_TYPES,
          },
        },
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        botUserId: BOT_USER_ID,
        client: countingMembershipClient([{ id: 'C-new', name: 'new', is_member: true } as SlackConversationInfo], counter),
        teamId,
      });

      await Promise.all(Array.from({ length: 5 }, () => service.getMemberConversations()));
      await waitForMembership(teamId, BOT_USER_ID, ['C-new']);

      assert.equal(counter.calls, 1, 'in-flight guard collapses concurrent refreshes to one');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('getUserByHandle recovers a fresh collection miss with one blocking full sync', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-handle-recovery-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-handle-recovery';
      await seedCache(teamId, {
        users: [{ id: 'U-old', name: 'old', syncedAt: nowIso() }],
        usersFullSyncAt: nowIso(),
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        client: countingUsersClient([
          { id: 'U-old', name: 'old' },
          { id: 'U-new', name: 'newbie', profile: { display_name: 'Newbie' } },
        ], counter),
        teamId,
      });

      const user = await service.getUserByHandle('newbie');

      assert.equal(user.id, 'U-new');
      assert.equal(counter.calls, 1, 'missing handle in a fresh collection triggers exactly one recovery sync');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('getUserByHandle negative handle recovery is cached for 60 seconds only', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-handle-negative-'));
  const realNow = Date.now;
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-handle-negative';
      let now = realNow();
      Date.now = () => now;
      await seedCache(teamId, {
        users: [{ id: 'U-old', name: 'old', syncedAt: nowIso() }],
        usersFullSyncAt: nowIso(),
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        client: countingUsersClient([{ id: 'U-old', name: 'old' }], counter),
        teamId,
      });

      await assert.rejects(() => service.getUserByHandle('missing'), /Slack user not found: @missing/);
      assert.equal(counter.calls, 1);
      await assert.rejects(() => service.getUserByHandle('missing'), /Slack user not found: @missing/);
      assert.equal(counter.calls, 1, 'fresh negative suppresses immediate recovery sync');

      now += 61_000;
      await assert.rejects(() => service.getUserByHandle('missing'), /Slack user not found: @missing/);
      assert.equal(counter.calls, 2, 'expired negative is pruned and the next lookup re-syncs');
    });
  } finally {
    Date.now = realNow;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('getUserByHandleForTarget recovers a fresh collection miss before target disambiguation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-target-handle-recovery-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-target-handle-recovery';
      await seedCache(teamId, {
        users: [{ id: 'U-old', name: 'old', syncedAt: nowIso() }],
        usersFullSyncAt: nowIso(),
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        client: countingUsersClient([{ id: 'U-new', name: 'newbie' }], counter),
        teamId,
      });

      const user = await service.getUserByHandleForTarget('newbie', { channelId: 'C-team' });

      assert.equal(user.id, 'U-new');
      assert.equal(counter.calls, 1);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('getConversationByName recovers a fresh collection miss with one blocking full sync', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-channel-name-recovery-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-channel-name-recovery';
      await seedCache(teamId, {
        channels: [{ id: 'C-old', name: 'old', syncedAt: nowIso() }],
        channelsFullSyncAt: nowIso(),
        channelsFullSyncTypes: 'public_channel,private_channel',
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        client: countingClient([{ id: 'C-new', name: 'new-room' } as SlackConversationInfo], counter),
        teamId,
      });

      const channel = await service.getConversationByName('new-room');

      assert.equal(channel.id, 'C-new');
      assert.equal(counter.calls, 1, 'missing channel name in a fresh collection triggers exactly one recovery sync');
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
        channels: [{ id: 'C-old', name: 'old', syncedAt: STALE_ISO }],
        channelsFullSyncAt: STALE_ISO,
        channelsFullSyncTypes: FULL_MEMBER_TYPES,
        memberships: {
          [BOT_USER_ID]: {
            channelIds: ['C-old'],
            syncedAt: STALE_ISO,
            syncedTypes: FULL_MEMBER_TYPES,
          },
        },
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        botUserId: BOT_USER_ID,
        client: countingMembershipClient([{ id: 'C-new', name: 'new', is_member: true } as SlackConversationInfo], counter),
        teamId,
      });

      await service.applyEvent({
        channel: { id: 'C-event', name: 'event', is_member: true } as SlackConversationInfo,
        team: teamId,
        type: 'channel_created',
      });
      const afterEvent = await getSlackWorkspaceDirectoryStore(teamId).read();
      assert.equal(afterEvent.channelsFullSyncAt, STALE_ISO, 'event upsert must not restamp full-sync time');
      assert.equal(
        afterEvent.channels.find((channel) => channel.id === 'C-event')?.isMember,
        undefined,
        'workspace events must not persist bot-relative membership',
      );

      const channels = await service.getMemberConversations();
      assert.deepEqual(channels.map((channel) => channel.id), ['C-old']);
      await waitForMembership(teamId, BOT_USER_ID, ['C-new']);
      assert.equal(counter.calls, 1, 'stale membership still refreshes from users.conversations after an event');
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
        botUserId: BOT_USER_ID,
        client: countingMembershipClient([{ id: 'C-new', name: 'new', is_member: true } as SlackConversationInfo], counter),
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

test('existing directory-v2 cache without bot memberships upgrades on first member read', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-v2-membership-upgrade-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-v2-membership-upgrade';
      const directory = join(stateDir, 'cache', 'slack', 'teams', teamId);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'directory-v2.json'), JSON.stringify({
        channels: [{ id: 'C-stale', isMember: false, name: 'stale', syncedAt: nowIso() }],
        channelsFullSyncAt: nowIso(),
        channelsFullSyncTypes: FULL_MEMBER_TYPES,
        teamId,
        users: [],
      }));
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        botUserId: BOT_USER_ID,
        client: countingMembershipClient(
          [{ id: 'C-live', is_member: true, name: 'live' } as SlackConversationInfo],
          counter,
        ),
        teamId,
      });

      assert.deepEqual((await service.getMemberConversations()).map((channel) => channel.id), ['C-live']);
      assert.equal(counter.calls, 1);
      const cache = await getSlackWorkspaceDirectoryStore(teamId).read();
      assert.deepEqual(cache.memberships[BOT_USER_ID]?.channelIds, ['C-live']);
      assert.equal(cache.channels.every((channel) => channel.isMember === undefined), true);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('membership cache is isolated by bot identity within one Slack workspace', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-bot-isolation-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-shared';
      const memberCounter = { calls: 0 };
      const nonMemberCounter = { calls: 0 };
      const member = new SlackWorkspaceDirectoryService({
        botUserId: 'U-member',
        client: countingMembershipClient(
          [{ id: 'C-duty', is_member: true, name: 'duty' } as SlackConversationInfo],
          memberCounter,
        ),
        teamId,
      });
      const nonMember = new SlackWorkspaceDirectoryService({
        botUserId: 'U-nonmember',
        client: countingMembershipClient([], nonMemberCounter),
        teamId,
      });

      assert.deepEqual((await member.getMemberConversations()).map((channel) => channel.id), ['C-duty']);
      assert.deepEqual(await nonMember.getMemberConversations(), []);
      assert.deepEqual(
        (await member.getMemberConversations()).map((channel) => channel.id),
        ['C-duty'],
        'a second bot writing the shared workspace cache cannot overwrite the first bot membership',
      );

      assert.equal(memberCounter.calls, 1, 'member bot reuses only its own fresh snapshot');
      assert.equal(nonMemberCounter.calls, 1, 'non-member bot reuses only its own fresh snapshot');
      const cache = await getSlackWorkspaceDirectoryStore(teamId).read();
      assert.deepEqual(cache.memberships['U-member']?.channelIds, ['C-duty']);
      assert.deepEqual(cache.memberships['U-nonmember']?.channelIds, []);
      assert.equal(cache.channels.find((channel) => channel.id === 'C-duty')?.isMember, undefined);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('live bot conversation lookup ignores poisoned shared membership and repairs metadata only', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-live-membership-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-live-membership';
      await seedCache(teamId, {
        channels: [{ id: 'C-duty', isMember: false, name: 'duty', syncedAt: nowIso() }],
      });
      const counter = { calls: 0 };
      const service = new SlackWorkspaceDirectoryService({
        botUserId: BOT_USER_ID,
        client: countingMembershipClient([], counter, {
          'C-duty': { id: 'C-duty', is_member: true, name: 'duty' } as SlackConversationInfo,
        }),
        teamId,
      });

      const conversation = await service.getConversationForCurrentBot('C-duty');

      assert.equal(conversation?.isMember, true, 'whois reads the calling bot live instead of shared membership');
      assert.equal(
        (await getSlackWorkspaceDirectoryStore(teamId).read()).channels[0]?.isMember,
        undefined,
        'the live answer cannot poison shared workspace metadata for another bot',
      );
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('bot-aware channel-name lookup recovers a member channel omitted from conversations.list', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-wd-member-name-'));
  try {
    await withAnimaHome(stateDir, async () => {
      const teamId = 'T-member-name';
      const counter = { calls: 0 };
      const dutyChannel = {
        id: 'C-duty',
        is_member: true,
        name: 'duty',
      } as SlackConversationInfo;
      const service = new SlackWorkspaceDirectoryService({
        botUserId: BOT_USER_ID,
        client: countingMembershipClient([dutyChannel], counter, { 'C-duty': dutyChannel }),
        teamId,
      });

      const conversation = await service.getConversationByNameForCurrentBot('duty', FULL_MEMBER_TYPES);

      assert.equal(conversation.id, 'C-duty');
      assert.equal(conversation.isMember, true);
      assert.equal(counter.calls, 1, 'the fallback uses the current bot member inventory once');
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

function countingUsersClient(users: SlackApiUser[], counter: { calls: number }): WebClient {
  return {
    users: {
      list: async () => {
        counter.calls += 1;
        return { members: users, ok: true };
      },
    },
  } as unknown as WebClient;
}

interface SlackApiUser {
  id: string;
  name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
  };
  real_name?: string;
}

async function waitForUser(
  teamId: string,
  userId: string,
  match: (user: SlackDirectoryUser) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  await waitFor(async () => {
    const user = (await getSlackWorkspaceDirectoryStore(teamId).read()).users.find((entry) => entry.id === userId);
    return user !== undefined && match(user);
  }, { description: `cache user ${userId} to match`, timeoutMs });
}
