// End-to-end acceptance for cut (c): real tool seams runMessageSend / runAsk /
// runFileSend — HELD exits 0 with sole HELD stdout and zero irreversible Slack
// ops; sent path appends own observation (including file share ts).

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { setCursorDeliveryEnabledForTests } from '../runtime/cursor-delivery.js';
import { ObservedConversationStore } from '../storage/schema/observed-conversation.store.js';
import { runMessageSend } from '../tools/messages.js';
import { runAsk } from '../tools/ask.js';
import { runFileSend } from '../tools/file-send.js';
import { withAnimaHome } from './anima-home.js';
import { startSlackApiMock, slackRequestBody } from './helpers/slack-api.js';

const BOT_USER = 'U-scout';
const TEAM = 'T-demo';
const CHANNEL = 'C-product';

async function writeScoutAgent(stateDir: string): Promise<void> {
  const agentDir = join(stateDir, 'agents', 'scout');
  const homePath = join(stateDir, 'home', 'scout');
  await mkdir(agentDir, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), '{}\n', 'utf8');
  await writeFile(
    join(agentDir, 'config.json'),
    `${JSON.stringify({
      id: 'scout',
      homePath,
      slack: {
        appToken: 'xapp-test',
        botToken: 'xoxb-test',
        botUserId: BOT_USER,
        teamId: TEAM,
      },
      provider: { kind: 'codex-cli', model: 'gpt-5.5' },
    }, null, 2)}\n`,
    'utf8',
  );
}

function baseSlackHandlers(posts: unknown[], uploads: string[]) {
  return (method: string, body: string) => {
    if (method === 'auth.test') {
      return { ok: true, team_id: TEAM, user_id: BOT_USER };
    }
    if (method === 'users.list') {
      return { ok: true, members: [{ id: 'U123', name: 'alice' }] };
    }
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
    if (method === 'conversations.members') {
      return { ok: true, members: ['U123', BOT_USER] };
    }
    if (method === 'chat.postMessage') {
      posts.push(slackRequestBody(body));
      return { ok: true, channel: CHANNEL, ts: '1770000999.000001' };
    }
    if (method === 'files.getUploadURLExternal') {
      uploads.push('getUploadURLExternal');
      return {
        ok: true,
        file_id: 'F-upload-1',
        upload_url: 'http://127.0.0.1:9/never-hit-if-held',
      };
    }
    if (method === 'files.completeUploadExternal') {
      uploads.push('completeUploadExternal');
      return { ok: true, files: [{ id: 'F-upload-1', title: 'note.txt' }] };
    }
    if (method === 'files.info') {
      return {
        ok: true,
        file: {
          id: 'F-upload-1',
          mimetype: 'text/plain',
          size: 4,
          permalink: 'https://example.test/F-upload-1',
          shares: {
            private: {
              [CHANNEL]: [{ ts: '1770000888.000222' }],
            },
          },
        },
      };
    }
    throw new Error(`unexpected slack method ${method}`);
  };
}

async function plantStaleSurface(agentId: string): Promise<ObservedConversationStore> {
  const store = new ObservedConversationStore(agentId);
  await store.observe({
    teamId: TEAM,
    channelId: CHANNEL,
    messageTs: '10.0',
    text: 'topic',
    userId: 'U_ROOT',
  });
  await store.advanceCursor({
    surfaceId: `slack:${TEAM}:${CHANNEL}`,
    expected: { status: 'absent' },
    nextDeliveredOrdinal: 1,
    lastDeliveredEventId: `slack:${TEAM}:${CHANNEL}:10.0`,
    lastDeliveredMessageTs: '10.0',
  });
  await store.observe({
    teamId: TEAM,
    channelId: CHANNEL,
    messageTs: '11.0',
    text: 'foreign-1',
    userId: 'U_OTHER',
    receivedAt: '2026-01-01T13:44:59.000Z',
  });
  return store;
}

// Serialize: tests mutate process.env + Slack mock URL + cursor flag.
describe('send-hold real tool seams', { concurrency: 1 }, () => {

test('runMessageSend HELD: exit path, sole HELD stdout, zero chat.postMessage', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-hold-msg-'));
  const posts: unknown[] = [];
  const uploads: string[] = [];
  const previousAgent = process.env.ANIMA_AGENT_ID;
  const previousSlack = process.env.ANIMA_SLACK_API_URL;
  const slackApi = await startSlackApiMock(baseSlackHandlers(posts, uploads));
  setCursorDeliveryEnabledForTests(true);
  const lines: string[] = [];
  try {
    process.env.ANIMA_AGENT_ID = 'scout';
    process.env.ANIMA_SLACK_API_URL = slackApi.url;
    await withAnimaHome(stateDir, async () => {
      await writeScoutAgent(stateDir);
      await plantStaleSurface('scout');
      await runMessageSend(
        { agent: 'scout', channel: CHANNEL, text: 'would-collide' },
        { writeOutput: (line) => lines.push(line) },
      );
    });
    assert.equal(posts.length, 0, 'HELD must not postMessage');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^HELD:/);
    assert.match(lines[0]!, /your message was not sent/);
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

test('runMessageSend sent path appends own observation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-hold-msg-sent-'));
  const posts: unknown[] = [];
  const uploads: string[] = [];
  const previousAgent = process.env.ANIMA_AGENT_ID;
  const previousSlack = process.env.ANIMA_SLACK_API_URL;
  const slackApi = await startSlackApiMock(baseSlackHandlers(posts, uploads));
  setCursorDeliveryEnabledForTests(true);
  const lines: string[] = [];
  try {
    process.env.ANIMA_AGENT_ID = 'scout';
    process.env.ANIMA_SLACK_API_URL = slackApi.url;
    await withAnimaHome(stateDir, async () => {
      await writeScoutAgent(stateDir);
      // Absent cursor → allow land.
      await runMessageSend(
        { agent: 'scout', channel: CHANNEL, text: 'hello-land' },
        { writeOutput: (line) => lines.push(line) },
      );
      const store = new ObservedConversationStore('scout');
      const journal = await store.readJournal(`slack:${TEAM}:${CHANNEL}`, { limit: 10 });
      assert.ok(
        journal.some((e) => e.messageTs === '1770000999.000001' && e.userId === BOT_USER),
        `expected own observation, got ${JSON.stringify(journal)}`,
      );
    });
    assert.equal(posts.length, 1);
    assert.match(lines.join('\n'), /sent successfully/);
    assert.doesNotMatch(lines.join('\n'), /^HELD:/m);
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

test('runAsk HELD: sole HELD stdout, zero chat.postMessage', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-hold-ask-'));
  const posts: unknown[] = [];
  const uploads: string[] = [];
  const previousAgent = process.env.ANIMA_AGENT_ID;
  const previousSlack = process.env.ANIMA_SLACK_API_URL;
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (msg?: unknown) => {
    if (typeof msg === 'string') lines.push(msg);
  };
  const slackApi = await startSlackApiMock(baseSlackHandlers(posts, uploads));
  setCursorDeliveryEnabledForTests(true);
  try {
    process.env.ANIMA_AGENT_ID = 'scout';
    process.env.ANIMA_SLACK_API_URL = slackApi.url;
    await withAnimaHome(stateDir, async () => {
      await writeScoutAgent(stateDir);
      await plantStaleSurface('scout');
      await runAsk({
        channel: CHANNEL,
        question: 'pick one?',
        option: ['A', 'B'],
        replyHint: true,
      });
    });
    assert.equal(posts.length, 0, 'HELD must not postMessage for ask');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^HELD:/);
    assert.match(lines[0]!, /your message was not sent/);
  } finally {
    console.log = originalLog;
    setCursorDeliveryEnabledForTests(undefined);
    if (previousAgent === undefined) delete process.env.ANIMA_AGENT_ID;
    else process.env.ANIMA_AGENT_ID = previousAgent;
    if (previousSlack === undefined) delete process.env.ANIMA_SLACK_API_URL;
    else process.env.ANIMA_SLACK_API_URL = previousSlack;
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runAsk sent path appends own observation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-hold-ask-sent-'));
  const posts: unknown[] = [];
  const uploads: string[] = [];
  const previousAgent = process.env.ANIMA_AGENT_ID;
  const previousSlack = process.env.ANIMA_SLACK_API_URL;
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (msg?: unknown) => {
    if (typeof msg === 'string') lines.push(msg);
  };
  const slackApi = await startSlackApiMock(baseSlackHandlers(posts, uploads));
  setCursorDeliveryEnabledForTests(true);
  try {
    process.env.ANIMA_AGENT_ID = 'scout';
    process.env.ANIMA_SLACK_API_URL = slackApi.url;
    await withAnimaHome(stateDir, async () => {
      await writeScoutAgent(stateDir);
      // Absent cursor → allow land.
      await runAsk({
        channel: CHANNEL,
        question: 'ship it?',
        option: ['yes', 'no'],
        replyHint: true,
      });
      const store = new ObservedConversationStore('scout');
      const journal = await store.readJournal(`slack:${TEAM}:${CHANNEL}`, { limit: 10 });
      assert.ok(
        journal.some((e) => e.messageTs === '1770000999.000001' && e.userId === BOT_USER),
        `expected own ask observation, got ${JSON.stringify(journal)}`,
      );
    });
    assert.equal(posts.length, 1, 'sent ask must postMessage once');
    assert.doesNotMatch(lines.join('\n'), /^HELD:/m);
  } finally {
    console.log = originalLog;
    setCursorDeliveryEnabledForTests(undefined);
    if (previousAgent === undefined) delete process.env.ANIMA_AGENT_ID;
    else process.env.ANIMA_AGENT_ID = previousAgent;
    if (previousSlack === undefined) delete process.env.ANIMA_SLACK_API_URL;
    else process.env.ANIMA_SLACK_API_URL = previousSlack;
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runFileSend HELD: sole HELD stdout, zero upload URL/bytes/complete', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-hold-file-'));
  const posts: unknown[] = [];
  const uploads: string[] = [];
  const previousAgent = process.env.ANIMA_AGENT_ID;
  const previousSlack = process.env.ANIMA_SLACK_API_URL;
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (msg?: unknown) => {
    if (typeof msg === 'string') lines.push(msg);
  };
  const filePath = join(stateDir, 'note.txt');
  const slackApi = await startSlackApiMock(baseSlackHandlers(posts, uploads));
  setCursorDeliveryEnabledForTests(true);
  try {
    process.env.ANIMA_AGENT_ID = 'scout';
    process.env.ANIMA_SLACK_API_URL = slackApi.url;
    await writeFile(filePath, 'hi\n', 'utf8');
    await withAnimaHome(stateDir, async () => {
      await writeScoutAgent(stateDir);
      await plantStaleSurface('scout');
      // caption: '' skips stdin read (undefined would hang on open stdin).
      await runFileSend({
        agent: 'scout',
        channel: CHANNEL,
        paths: [filePath],
        caption: '',
      });
    });
    assert.deepEqual(uploads, [], 'HELD must not start file upload');
    assert.equal(posts.length, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^HELD:/);
    assert.match(lines[0]!, /your file was not sent/);
  } finally {
    console.log = originalLog;
    setCursorDeliveryEnabledForTests(undefined);
    if (previousAgent === undefined) delete process.env.ANIMA_AGENT_ID;
    else process.env.ANIMA_AGENT_ID = previousAgent;
    if (previousSlack === undefined) delete process.env.ANIMA_SLACK_API_URL;
    else process.env.ANIMA_SLACK_API_URL = previousSlack;
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('runFileSend sent path journals own observation via share ts', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-hold-file-sent-'));
  const posts: unknown[] = [];
  const uploads: string[] = [];
  const previousAgent = process.env.ANIMA_AGENT_ID;
  const previousSlack = process.env.ANIMA_SLACK_API_URL;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (msg?: unknown) => {
    if (typeof msg === 'string') lines.push(msg);
  };
  // Byte POST to upload_url (not Slack JSON API) — never fall through to real network.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
    if (url.includes('upload-bytes') || (init?.method ?? 'GET').toUpperCase() === 'POST') {
      return new Response(null, { status: 200 });
    }
    return originalFetch(input as never, init);
  }) as typeof fetch;
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'files.getUploadURLExternal') {
      uploads.push('getUploadURLExternal');
      return {
        ok: true,
        file_id: 'F-upload-1',
        upload_url: 'http://127.0.0.1/upload-bytes',
      };
    }
    return baseSlackHandlers(posts, uploads)(method, body);
  });
  setCursorDeliveryEnabledForTests(true);
  const filePath = join(stateDir, 'note.txt');
  try {
    process.env.ANIMA_AGENT_ID = 'scout';
    process.env.ANIMA_SLACK_API_URL = slackApi.url;
    await writeFile(filePath, 'hi\n', 'utf8');
    await withAnimaHome(stateDir, async () => {
      await writeScoutAgent(stateDir);
      await runFileSend({
        agent: 'scout',
        channel: CHANNEL,
        paths: [filePath],
        caption: 'file caption',
      });
      const store = new ObservedConversationStore('scout');
      const journal = await store.readJournal(`slack:${TEAM}:${CHANNEL}`, { limit: 10 });
      assert.ok(
        journal.some((e) => e.messageTs === '1770000888.000222' && e.userId === BOT_USER),
        `expected own file share observation, got ${JSON.stringify(journal)}`,
      );
    });
    assert.ok(uploads.includes('getUploadURLExternal'));
    assert.ok(uploads.includes('completeUploadExternal'));
    assert.match(lines.join('\n'), /uploaded successfully|files=/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    setCursorDeliveryEnabledForTests(undefined);
    if (previousAgent === undefined) delete process.env.ANIMA_AGENT_ID;
    else process.env.ANIMA_AGENT_ID = previousAgent;
    if (previousSlack === undefined) delete process.env.ANIMA_SLACK_API_URL;
    else process.env.ANIMA_SLACK_API_URL = previousSlack;
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

}); // describe concurrency:1
