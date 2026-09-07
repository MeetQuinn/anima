import test from 'node:test';
import assert from 'node:assert/strict';
import type { WebClient } from '@slack/web-api';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSlackPreviewWebClient } from '../slack/client.js';

import { waitForSlackMessagePreviewAttachments } from '../slack/message-previews.js';
import { normalizeSlackMessage } from '../inbox/slack-events.js';

test('delayed Slack preview wait returns containing-message unfurl attachments before enqueue', async () => {
  const link = 'https://quinn-ai.slack.com/archives/C01KWJZHX1N/p1782746386955099';
  const text = `<${link}> can you see this?`;
  const calls: Array<{ channel?: string; latest?: string; oldest?: string }> = [];
  const client = {
    conversations: {
      history: async (args: { channel?: string; latest?: string; oldest?: string }) => {
        calls.push(args);
        return {
          messages: [{
            attachments: calls.length === 1 ? [] : [{
              author_id: 'U-ben',
              author_name: 'Ben',
              channel_id: 'C-private-target',
              from_url: link,
              is_msg_unfurl: true,
              text: 'Preview delivered by Slack after the realtime event',
              ts: '1782746386.955099',
            }],
            ts: '1782810152.448799',
          }],
        };
      },
    },
  } as unknown as Pick<WebClient, 'conversations'>;

  const attachments = await waitForSlackMessagePreviewAttachments({
    channelId: 'D-containing',
    client,
    messageTs: '1782810152.448799',
    retryDelaysMs: [0, 0],
    text,
  });

  assert.deepEqual(calls, [
    { channel: 'D-containing', inclusive: true, latest: '1782810152.448799', limit: 1, oldest: '1782810152.448799' },
    { channel: 'D-containing', inclusive: true, latest: '1782810152.448799', limit: 1, oldest: '1782810152.448799' },
  ]);

  const normalized = normalizeSlackMessage({
    envelope: { team_id: 'T-demo' },
    event: {
      attachments,
      channel: 'D-containing',
      text,
      ts: '1782810152.448799',
      type: 'message',
      user: 'U-owner',
    },
  });
  assert.deepEqual(normalized.previews, [{
    authorId: 'U-ben',
    authorName: 'Ben',
    channelId: 'C-private-target',
    fromUrl: link,
    messageTs: '1782746386.955099',
    text: 'Preview delivered by Slack after the realtime event',
  }]);
});

test('delayed Slack preview wait skips messages without Slack permalinks', async () => {
  let calls = 0;
  const client = {
    conversations: {
      history: async () => {
        calls += 1;
        return { messages: [] };
      },
    },
  } as unknown as Pick<WebClient, 'conversations'>;

  const attachments = await waitForSlackMessagePreviewAttachments({
    channelId: 'D-containing',
    client,
    messageTs: '1782810200.000001',
    retryDelaysMs: [0],
    text: 'plain text only',
  });

  assert.equal(attachments, undefined);
  assert.equal(calls, 0);
});

test('preview budget bounds a hung initial read and aborts its client without another retry', async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const client = {
    conversations: { history: async () => { calls++; return new Promise(() => {}); } },
  } as unknown as Pick<WebClient, 'conversations'>;
  const start = performance.now();
  assert.equal(await waitForSlackMessagePreviewAttachments({
    channelId: 'D-containing', messageTs: '1782810200.000001', client,
    createClient: (value) => { signal = value; return client; },
    text: 'https://demo.slack.com/archives/C0PRIVATE1/p1770000100000001',
    timeoutMs: 30, retryDelaysMs: [0, 0, 0],
  }), undefined);
  assert.ok(performance.now() - start < 1_000);
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

test('preview budget includes retry sleeps and leaves no later lookup', async () => {
  let calls = 0;
  const client = {
    conversations: { history: async () => { calls++; return { messages: [] }; } },
  } as unknown as Pick<WebClient, 'conversations'>;
  assert.equal(await waitForSlackMessagePreviewAttachments({
    channelId: 'D-containing', messageTs: '1782810200.000001', client,
    text: 'https://demo.slack.com/archives/C0PRIVATE1/p1770000100000001',
    timeoutMs: 20, retryDelaysMs: [0, 40],
  }), undefined);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, 1);
});

test('lookup errors degrade without losing the message or reading a target channel', async () => {
  const channels: unknown[] = [];
  const client = {
    conversations: { history: async (args: { channel: string }) => {
      channels.push(args.channel);
      throw new Error('channel_not_found');
    } },
  } as unknown as Pick<WebClient, 'conversations'>;
  assert.equal(await waitForSlackMessagePreviewAttachments({
    channelId: 'D-containing', messageTs: '1782810200.000001', client,
    text: 'https://demo.slack.com/archives/C0PRIVATE1/p1770000100000001',
    retryDelaysMs: [0, 0, 0], warn: () => {},
  }), undefined);
  assert.deepEqual(channels, ['D-containing', 'D-containing', 'D-containing']);
});

test('production preview transport aborts hanging HTTP and rejects rate-limit backoff', async () => {
  let requests = 0;
  let mode: 'hang' | 'rate-limit' = 'hang';
  let closed!: () => void;
  const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
  const server = createServer((_request, response) => {
    requests++;
    if (mode === 'hang') response.on('close', closed);
    else response.writeHead(429, { 'retry-after': '60' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previousUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  const unusedClient = {} as Pick<WebClient, 'conversations'>;
  const input = {
    client: unusedClient,
    createClient: (signal: AbortSignal) => createSlackPreviewWebClient('test-only-token', signal),
    channelId: 'D-containing', messageTs: '1782810200.000001',
    text: 'https://demo.slack.com/archives/C0PRIVATE1/p1770000100000001',
    retryDelaysMs: [0], timeoutMs: 200, warn: () => {},
  };
  try {
    assert.equal(await waitForSlackMessagePreviewAttachments(input), undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([socketClosed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('preview socket was not aborted')), 500);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(requests, 1);
    mode = 'rate-limit';
    const start = performance.now();
    assert.equal(await waitForSlackMessagePreviewAttachments({ ...input, timeoutMs: 1_000 }), undefined);
    assert.ok(performance.now() - start < 800, '429 must not wait for SDK backoff or total deadline');
    assert.equal(requests, 2);
  } finally {
    if (previousUrl === undefined) delete process.env.ANIMA_SLACK_API_URL;
    else process.env.ANIMA_SLACK_API_URL = previousUrl;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
