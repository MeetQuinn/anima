// Enable cut: default-on atomic flag + acceptance-1 counting shape pin.
// wake (cursor view) → send while stale → HELD with delta → revised resend lands.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  prepareCursorDelivery,
  resolveCursorDeliveryEnabled,
  setCursorDeliveryEnabledForTests,
} from '../runtime/cursor-delivery.js';
import { ObservedConversationStore } from '../storage/schema/observed-conversation.store.js';
import { runMessageSend } from '../tools/messages.js';
import { withAnimaHome } from './anima-home.js';
import { startSlackApiMock, slackRequestBody } from './helpers/slack-api.js';

const BOT = 'U-iris';
const TEAM = 'T-demo';
const CHANNEL = 'C-product';

async function writeAgent(stateDir: string, serverConfig: object = {}): Promise<void> {
  const agentDir = join(stateDir, 'agents', 'iris');
  const homePath = join(stateDir, 'home', 'iris');
  await mkdir(agentDir, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), `${JSON.stringify(serverConfig, null, 2)}\n`);
  await writeFile(
    join(agentDir, 'config.json'),
    `${JSON.stringify({
      id: 'iris',
      homePath,
      slack: {
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        botUserId: BOT,
        teamId: TEAM,
      },
      provider: { kind: 'codex-cli', model: 'gpt-5.5' },
    }, null, 2)}\n`,
  );
}

function slackHandlers(posts: Array<Record<string, unknown>>) {
  return (method: string, body: string) => {
    if (method === 'auth.test') return { ok: true, team_id: TEAM, user_id: BOT };
    if (method === 'users.list') return { ok: true, members: [{ id: 'U_MILO', name: 'milo' }, { id: 'U_TESS', name: 'tess' }] };
    if (method === 'users.conversations' || method === 'conversations.list') {
      return {
        ok: true,
        channels: [{ id: CHANNEL, name: 'product', name_normalized: 'product', is_channel: true }],
      };
    }
    if (method === 'conversations.info') {
      return {
        ok: true,
        channel: { id: CHANNEL, is_channel: true, name: 'product', name_normalized: 'product' },
      };
    }
    if (method === 'conversations.members') return { ok: true, members: [BOT, 'U_MILO', 'U_TESS'] };
    if (method === 'chat.postMessage') {
      posts.push(slackRequestBody(body));
      return { ok: true, channel: CHANNEL, ts: `1770000${posts.length}.000001` };
    }
    throw new Error(`unexpected slack method ${method}`);
  };
}

test('default config enables cursor delivery + hold (atomic)', async () => {
  // No override; empty server config → enabled after enable cut.
  setCursorDeliveryEnabledForTests(undefined);
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-enable-default-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeAgent(stateDir, {});
      const resolved = await resolveCursorDeliveryEnabled();
      assert.equal(resolved.kind, 'enabled');
    });
  } finally {
    setCursorDeliveryEnabledForTests(undefined);
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('explicit cursorDelivery.enabled:false still disables', async () => {
  setCursorDeliveryEnabledForTests(undefined);
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-enable-off-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await writeAgent(stateDir, { cursorDelivery: { enabled: false } });
      const resolved = await resolveCursorDeliveryEnabled();
      assert.equal(resolved.kind, 'disabled');
    });
  } finally {
    setCursorDeliveryEnabledForTests(undefined);
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('acceptance-1 under enabled flag: threaded counting shape', async () => {
  // Live counting shape (artifact pin under default-on):
  // channel-root wake → response-thread present@0 → foreign thread replies 1/2
  // → real runMessageSend(threadTs) HELD (zero posts) → revised threaded resend lands
  // Hold basis is the **child thread** cursor, not the channel root.
  setCursorDeliveryEnabledForTests(undefined); // use default-on
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-enable-a1-'));
  const posts: Array<Record<string, unknown>> = [];
  const previousAgent = process.env.ANIMA_AGENT_ID;
  const previousSlack = process.env.ANIMA_SLACK_API_URL;
  const slackApi = await startSlackApiMock(slackHandlers(posts));
  const stdoutLines: string[] = [];
  const threadSurface = `slack:${TEAM}:${CHANNEL}:thread:100.0`;
  try {
    process.env.ANIMA_AGENT_ID = 'iris';
    process.env.ANIMA_SLACK_API_URL = slackApi.url;
    await withAnimaHome(stateDir, async () => {
      await writeAgent(stateDir, {}); // default on
      const store = new ObservedConversationStore('iris');

      // Topic post (counting-thread root) — journaled at ingress.
      await store.observe({
        teamId: TEAM,
        channelId: CHANNEL,
        messageTs: '100.0',
        text: 'count with me',
        userId: 'U_ROOT',
        receivedAt: '2026-01-01T13:44:29.000Z',
      });

      const wakeItem = {
        id: `slack:${TEAM}:${CHANNEL}:100.0`,
        kind: 'slack' as const,
        teamId: TEAM,
        channelId: CHANNEL,
        messageTs: '100.0',
        text: 'count with me',
        receivedAt: '2026-01-01T13:44:29.000Z',
        actor: { userId: 'U_ROOT' },
        handling: {
          createdAt: '2026-01-01T13:44:29.000Z',
          queuedAt: '2026-01-01T13:44:29.000Z',
          status: 'queued' as const,
          updatedAt: '2026-01-01T13:44:29.000Z',
        },
      };

      // 1) Wake prepares cursor view + establishes response-thread present@0.
      const prepared = await prepareCursorDelivery({
        agentId: 'iris',
        item: wakeItem,
        store,
      });
      assert.equal(prepared.kind, 'prepared');
      if (prepared.kind !== 'prepared') return;
      assert.match(prepared.plan.promptBody, /Slack conversation update:/);
      const child = prepared.plan.surfaces.find((s) => s.surfaceId === threadSurface);
      assert.ok(child?.establishOnly, 'response-thread established for first reply');

      // Simulate commit of the wake cursor (runtime.started).
      await store.advanceCursor({
        surfaceId: `slack:${TEAM}:${CHANNEL}`,
        expected: { status: 'absent' },
        nextDeliveredOrdinal: 1,
        lastDeliveredEventId: `slack:${TEAM}:${CHANNEL}:100.0`,
        lastDeliveredMessageTs: '100.0',
      });
      await store.advanceCursor({
        surfaceId: threadSurface,
        expected: { status: 'absent' },
        nextDeliveredOrdinal: 0,
      });
      const childBefore = await store.getCursor(threadSurface);
      assert.equal(childBefore.status, 'present');
      if (childBefore.status === 'present') {
        assert.equal(childBefore.deliveredOrdinal, 0);
      }

      // 2) Foreign replies *in the response thread* (milo "1", tess "2").
      await store.observe({
        teamId: TEAM,
        channelId: CHANNEL,
        messageTs: '101.0',
        threadTs: '100.0',
        text: '1',
        userId: 'U_MILO',
        receivedAt: '2026-01-01T13:44:59.000Z',
      });
      await store.observe({
        teamId: TEAM,
        channelId: CHANNEL,
        messageTs: '102.0',
        threadTs: '100.0',
        text: '2',
        userId: 'U_TESS',
        receivedAt: '2026-01-01T13:45:20.000Z',
      });

      // 3) First attempted send is the real tool seam into the thread → HELD.
      await runMessageSend(
        { agent: 'iris', channel: CHANNEL, threadTs: '100.0', text: '1' },
        { writeOutput: (line) => stdoutLines.push(line) },
      );
      assert.equal(posts.length, 0, 'stale runMessageSend must not postMessage');
      assert.equal(stdoutLines.length, 1, 'sole HELD stdout outcome');
      assert.match(stdoutLines[0]!, /^HELD:/);
      assert.match(stdoutLines[0]!, /2 new messages arrived/);
      assert.match(stdoutLines[0]!, /1/);
      assert.match(stdoutLines[0]!, /2/);

      // Child thread cursor advanced through foreign tail (hold basis is the thread).
      const childAfterHold = await store.getCursor(threadSurface);
      assert.equal(childAfterHold.status, 'present');
      if (childAfterHold.status === 'present') {
        assert.equal(
          childAfterHold.deliveredOrdinal,
          2,
          'child thread cursor must advance through foreign 1/2',
        );
      }
      // Root is not the hold basis — remains at wake commit.
      const rootAfterHold = await store.getCursor(`slack:${TEAM}:${CHANNEL}`);
      assert.equal(rootAfterHold.status, 'present');
      if (rootAfterHold.status === 'present') {
        assert.equal(rootAfterHold.deliveredOrdinal, 1);
      }

      // 4) Revised threaded resend ("3") lands once with thread_ts=100.0.
      stdoutLines.length = 0;
      await runMessageSend(
        { agent: 'iris', channel: CHANNEL, threadTs: '100.0', text: '3' },
        { writeOutput: (line) => stdoutLines.push(line) },
      );
      assert.equal(posts.length, 1, 'revised threaded resend must land once');
      assert.doesNotMatch(stdoutLines.join('\n'), /^HELD:/m);
      assert.match(stdoutLines.join('\n'), /sent successfully/);
      const body = posts[0]!;
      assert.equal(body['thread_ts'], '100.0');
      assert.match(String(body['text'] ?? ''), /3/);
    });
  } finally {
    setCursorDeliveryEnabledForTests(undefined);
    if (previousAgent === undefined) delete process.env.ANIMA_AGENT_ID;
    else process.env.ANIMA_AGENT_ID = previousAgent;
    if (previousSlack === undefined) delete process.env.ANIMA_SLACK_API_URL;
    else process.env.ANIMA_SLACK_API_URL = previousSlack;
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});