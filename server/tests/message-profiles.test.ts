import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichInboundAvatars, type AvatarEnrichmentDeps } from '../web/message-profiles.js';
import type {
  AgentMessageHistoryPage,
  AgentMessageRecord,
} from '../../shared/messages.js';

// Read-time avatar enrichment is a decorative, best-effort decoration on the
// /messages route. These tests pin the backend contract Milo gated on:
//   • enriches inbound Slack rows
//   • dedupes one resolver call per unique sender
//   • skips outbound / Feishu / non-Slack ids
//   • missing token OR missing team id returns the page with no Slack calls
//   • resolver failure returns the original page unchanged
// The external touchpoints (agent config, web client, profile resolver) are
// injected so the contract is exercised with zero real Slack IO.

function makeRecord(over: Partial<AgentMessageRecord>): AgentMessageRecord {
  return {
    direction: 'in',
    kind: 'message',
    messageId: over.messageId ?? 'm-1',
    source: { id: 's-1', kind: 'inbox' },
    text: 'hi',
    timestamp: '2026-06-26T00:00:00.000Z',
    ...over,
  };
}

function page(entries: AgentMessageRecord[]): AgentMessageHistoryPage {
  return { entries, nextCursor: null };
}

// A deps double that records every external call so the test can assert both
// behaviour (what got enriched) and cost (how many resolver calls fired).
function makeDeps(
  over: Partial<AvatarEnrichmentDeps> & {
    botToken?: string | undefined;
    teamId?: string | undefined;
    avatarFor?: (userId: string) => string | undefined;
  } = {},
) {
  const calls = { loadAgent: 0, getWebClient: 0, resolvedUsers: [] as string[] };
  const botToken = 'botToken' in over ? over.botToken : 'xoxb-test';
  const teamId = 'teamId' in over ? over.teamId : 'T-team';
  const avatarFor = over.avatarFor ?? ((u: string) => `https://avatars.test/${u}.png`);
  const deps: AvatarEnrichmentDeps = {
    loadAgent: over.loadAgent
      ? over.loadAgent
      : async (agentId) => {
          calls.loadAgent += 1;
          return { id: agentId, slack: { botToken, teamId } };
        },
    getWebClient: over.getWebClient
      ? over.getWebClient
      : async () => {
          calls.getWebClient += 1;
          return { fake: 'client' };
        },
    resolveAvatar: over.resolveAvatar
      ? over.resolveAvatar
      : async ({ userId }) => {
          calls.resolvedUsers.push(userId);
          return avatarFor(userId);
        },
  };
  return { deps, calls };
}

test('enriches inbound Slack rows with the resolved avatar url', async () => {
  const { deps } = makeDeps();
  const result = await enrichInboundAvatars(
    'scout',
    page([makeRecord({ messageId: 'm-1', actorUserId: 'U0ALICE001' })]),
    deps,
  );
  assert.equal(result.entries[0]!.actorAvatarUrl, 'https://avatars.test/U0ALICE001.png');
});

test('dedupes to one resolver call per unique sender', async () => {
  const { deps, calls } = makeDeps();
  const result = await enrichInboundAvatars(
    'scout',
    page([
      makeRecord({ messageId: 'm-1', actorUserId: 'U0ALICE001' }),
      makeRecord({ messageId: 'm-2', actorUserId: 'U0ALICE001' }),
      makeRecord({ messageId: 'm-3', actorUserId: 'U0BOB0002' }),
    ]),
    deps,
  );
  // U0ALICE001 appears twice but resolves once; U0BOB0002 once. Two unique calls.
  assert.equal(calls.resolvedUsers.length, 2);
  assert.deepEqual([...calls.resolvedUsers].sort(), ['U0ALICE001', 'U0BOB0002']);
  // Both U0ALICE001 rows still get the avatar from the single lookup.
  assert.equal(result.entries[0]!.actorAvatarUrl, 'https://avatars.test/U0ALICE001.png');
  assert.equal(result.entries[1]!.actorAvatarUrl, 'https://avatars.test/U0ALICE001.png');
  assert.equal(result.entries[2]!.actorAvatarUrl, 'https://avatars.test/U0BOB0002.png');
});

test('skips outbound, Feishu, and non-Slack ids (no Slack calls, page unchanged)', async () => {
  const { deps, calls } = makeDeps();
  const input = page([
    makeRecord({ messageId: 'm-out', direction: 'out', actorUserId: 'U0SELF003' }),
    makeRecord({ messageId: 'm-feishu', platform: 'feishu', actorUserId: 'U0FEISHU04' }),
    makeRecord({ messageId: 'm-open', actorUserId: 'ou_abc123' }), // feishu open id
    makeRecord({ messageId: 'm-none' }), // no actorUserId at all
  ]);
  const result = await enrichInboundAvatars('scout', input, deps);
  // No eligible sender → short-circuit before any external touchpoint.
  assert.equal(calls.loadAgent, 0);
  assert.equal(calls.getWebClient, 0);
  assert.equal(calls.resolvedUsers.length, 0);
  assert.equal(result, input); // same reference: untouched
});

test('missing bot token returns the original page with no Slack calls', async () => {
  const { deps, calls } = makeDeps({ botToken: undefined });
  const input = page([makeRecord({ messageId: 'm-1', actorUserId: 'U0ALICE001' })]);
  const result = await enrichInboundAvatars('scout', input, deps);
  assert.equal(calls.getWebClient, 0);
  assert.equal(calls.resolvedUsers.length, 0);
  assert.equal(result, input);
});

test('missing team id returns the original page without resolving (disk cache guard)', async () => {
  for (const teamId of [undefined, '']) {
    const { deps, calls } = makeDeps({ teamId });
    const input = page([makeRecord({ messageId: 'm-1', actorUserId: 'U0ALICE001' })]);
    const result = await enrichInboundAvatars('scout', input, deps);
    assert.equal(calls.getWebClient, 0, `teamId=${JSON.stringify(teamId)}`);
    assert.equal(calls.resolvedUsers.length, 0, `teamId=${JSON.stringify(teamId)}`);
    assert.equal(result, input, `teamId=${JSON.stringify(teamId)}`);
  }
});

test('resolver failure returns the original page unchanged', async () => {
  const { deps } = makeDeps({
    resolveAvatar: async () => {
      throw new Error('slack users.info exploded');
    },
  });
  const input = page([makeRecord({ messageId: 'm-1', actorUserId: 'U0ALICE001' })]);
  const result = await enrichInboundAvatars('scout', input, deps);
  assert.equal(result, input);
  assert.equal(result.entries[0]!.actorAvatarUrl, undefined);
});

test('a sender with no photo leaves that row on the initials fallback', async () => {
  const { deps } = makeDeps({ avatarFor: (u) => (u === 'U0BOB0002' ? undefined : `https://avatars.test/${u}.png`) });
  const result = await enrichInboundAvatars(
    'scout',
    page([
      makeRecord({ messageId: 'm-1', actorUserId: 'U0ALICE001' }),
      makeRecord({ messageId: 'm-2', actorUserId: 'U0BOB0002' }),
    ]),
    deps,
  );
  assert.equal(result.entries[0]!.actorAvatarUrl, 'https://avatars.test/U0ALICE001.png');
  assert.equal(result.entries[1]!.actorAvatarUrl, undefined); // honest degrade
});
