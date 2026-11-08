import assert from 'node:assert/strict';
import test from 'node:test';

import type { WebClient } from '@slack/web-api';

import { observedNameReader } from '../runtime/observed-readable-names.js';
import type { SlackProfileResolver, SlackUserProfile } from '../slack/profiles.js';
import type { ObservedConversationEntry } from '../storage/schema/observed-conversation.store.js';

const client = (): WebClient => ({}) as WebClient;

function fakeProfiles(input: {
  channels?: Record<string, string>;
  hang?: boolean;
  users?: Record<string, SlackUserProfile>;
}): SlackProfileResolver & { userLookups: string[] } {
  const userLookups: string[] = [];
  return {
    userLookups,
    async user({ userId }: { userId: string }) {
      userLookups.push(userId);
      if (input.hang) return new Promise<undefined>(() => {});
      return input.users?.[userId];
    },
    async conversation({ channelId }: { channelId: string }) {
      const name = input.channels?.[channelId];
      return name ? { name } : {};
    },
    async displayText(): Promise<string> {
      throw new Error('not used by the reader');
    },
  } as unknown as SlackProfileResolver & { userLookups: string[] };
}

function row(partial: Partial<ObservedConversationEntry> & { messageTs: string; text: string }): ObservedConversationEntry {
  return {
    channelId: 'C1',
    eventId: `slack:T1:C1:${partial.messageTs}`,
    observedAt: '2026-11-08T00:00:00.000Z',
    ordinal: 1,
    receivedAt: '2026-11-08T00:00:00.000Z',
    surfaceId: 'slack:T1:C1',
    teamId: 'T1',
    ...partial,
  };
}

test('rows read like the wake trigger: named sender, readable mentions, decoded entities', async () => {
  const profiles = fakeProfiles({
    channels: { C9: 'team' },
    users: {
      U1: { displayName: 'Totoday Qiang', handle: 'totodayqiang' },
      U2: { displayName: 'nora', handle: 'nora' },
    },
  });
  const read = observedNameReader({ client, profiles, teamId: 'T1' });

  const [first, second] = await read([
    row({ messageTs: '1.0', text: 'hi <@U2>, see <#C9> &amp; ask', userId: 'U1' }),
    row({ messageTs: '2.0', text: 'thanks <@U1>', userId: 'U2' }),
  ]);

  assert.equal(first?.senderLabel, 'Totoday Qiang (@totodayqiang)');
  assert.equal(first?.text, 'hi @nora, see #team & ask');
  assert.equal(second?.senderLabel, '@nora', 'a name equal to the handle collapses, as on the trigger line');
  assert.equal(second?.text, 'thanks @totodayqiang');
  assert.deepEqual([...profiles.userLookups].sort(), ['U1', 'U2'], 'each user is looked up once');
});

test('an unresolved sender keeps its id and a bot-only row is untouched', async () => {
  const read = observedNameReader({ client, profiles: fakeProfiles({}), teamId: 'T1' });

  const [human, bot] = await read([
    row({ messageTs: '1.0', text: 'ping <@U7>', userId: 'U7' }),
    row({ botId: 'B1', messageTs: '2.0', text: 'deploy done' }),
  ]);

  assert.equal(human?.senderLabel, undefined);
  assert.equal(human?.text, 'ping @U7');
  assert.equal(bot?.senderLabel, undefined);
  assert.equal(bot?.text, 'deploy done');
});

test('a lookup past the deadline is cancelled and leaves rows as journaled', async () => {
  let signal: AbortSignal | undefined;
  const read = observedNameReader({
    client: (lookupSignal) => {
      signal = lookupSignal;
      return {} as WebClient;
    },
    profiles: fakeProfiles({ hang: true }),
    teamId: 'T1',
    timeoutMs: 20,
  });
  const rows = [row({ messageTs: '1.0', text: 'hi <@U2>', userId: 'U1' })];

  assert.deepEqual(await read(rows), rows);
  assert.equal(signal?.aborted, true, 'the lookups still in flight are aborted');
});
