import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebClient } from '@slack/web-api';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildSlackInboxItem } from '../inbox/slack-ingest.js';
import { runIngestPipeline } from '../inbox/ingest-pipeline.js';
import { SlackInboxItem } from '../../shared/inbox.js';
import { buildCodeAgentDeliveryPrompt, renderSlackCursorExtras } from '../runtime/delivery-prompt.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { slackMessageContentForText } from '../tools/slack-message-format.js';
import { withAnimaHome } from './anima-home.js';
import { defaultAgentConfig, withTempAnimaHome, writeAgentConfigs, withTimeout } from './helpers/harness.js';
import { makeSlackEvent } from './helpers/slack.js';
import { startRunningAgent } from '../runtime/agent-runner.js';
import { TeamRunLimiter } from '../runtime/team-run-limiter.js';
import { SlackInboxSubscriber } from '../inbox/slack-subscriber.js';
import { SlackProfileResolver } from '../slack/profiles.js';
import { bearerToken, startSlackApiMock } from './helpers/slack-api.js';

interface FakeSlackCalls {
  api: string[];
  getPermalink: Array<{ channel?: string; message_ts?: string }>;
  history: Array<{ channel?: string; latest?: string; oldest?: string }>;
  conversationsInfo: string[];
  usersInfo: string[];
}

function fakeIngestClient(input: {
  calls: FakeSlackCalls;
  historyAttachments?: unknown[];
  failLookups?: boolean;
  permalink?: string;
}): WebClient {
  return {
    chat: {
      getPermalink: async (args: { channel?: string; message_ts?: string }) => {
        input.calls.getPermalink.push(args);
        input.calls.api.push('chat.getPermalink');
        if (input.failLookups) throw new Error('permalink boom');
        return { ok: true, permalink: input.permalink ?? 'https://demo.slack.com/archives/permalink' };
      },
    },
    conversations: {
      history: async (args: { channel?: string; latest?: string; oldest?: string }) => {
        input.calls.history.push(args);
        input.calls.api.push('conversations.history');
        return {
          messages: [{
            ...(input.historyAttachments ? { attachments: input.historyAttachments } : {}),
            ts: args.latest,
          }],
          ok: true,
        };
      },
      info: async (args: { channel?: string }) => {
        input.calls.conversationsInfo.push(args.channel ?? '');
        input.calls.api.push(`conversations.info:${args.channel ?? ''}`);
        if (input.failLookups) throw new Error('conversations boom');
        return { channel: { id: args.channel, name: 'team', name_normalized: 'team' }, ok: true };
      },
    },
    users: {
      info: async (args: { user?: string }) => {
        input.calls.usersInfo.push(args.user ?? '');
        input.calls.api.push(`users.info:${args.user ?? ''}`);
        if (input.failLookups) throw new Error('users boom');
        const users: Record<string, { display_name?: string; handle: string; real_name?: string }> = {
          'UALICE1': { display_name: 'Alice', handle: 'alice', real_name: 'Alice Lee' },
          'UB0B1': { display_name: 'Bob', handle: 'bob' },
        };
        const user = users[args.user ?? ''];
        if (!user) throw new Error(`unknown user ${args.user}`);
        return {
          ok: true,
          user: {
            id: args.user,
            name: user.handle,
            profile: {
              display_name: user.display_name,
              image_72: `https://avatars.slack-edge.com/${user.handle}_72.png`,
              real_name: user.real_name,
            },
            ...(args.user === 'UALICE1'
              ? { tz: 'Asia/Shanghai', tz_label: 'China Standard Time', tz_offset: 28800 }
              : {}),
          },
        };
      },
    },
  } as unknown as WebClient;
}

function emptyCalls(): FakeSlackCalls {
  return { api: [], conversationsInfo: [], getPermalink: [], history: [], usersInfo: [] };
}

async function withIngestHome<T>(body: () => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-slack-ingest-test-'));
  try {
    return await withAnimaHome(stateDir, body);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
}

test('buildSlackInboxItem enriches profile, channel, mentions, permalink, and files', async () => {
  await withIngestHome(async () => {
    const calls = emptyCalls();
    const item = await buildSlackInboxItem({
      client: fakeIngestClient({ calls }),
      envelope: { team_id: 'T-ingest' },
      event: {
        channel: 'C-team',
        channel_type: 'channel',
        files: [{
          id: 'F-shot',
          mimetype: 'image/png',
          name: 'shot.png',
          size: 2048,
          url_private: 'https://files.slack.com/private',
        }],
        text: '<@UB0B1> please review',
        thread_ts: '1770000000.000001',
        ts: '1770000010.000001',
        type: 'message',
        user: 'UALICE1',
      },
      warn: () => {},
    });

    assert.equal(item.id, 'slack:T-ingest:C-team:1770000010.000001');
    assert.equal(item.teamId, 'T-ingest');
    assert.equal(item.channelId, 'C-team');
    assert.equal(item.channelName, 'team');
    assert.equal(item.threadTs, '1770000000.000001');
    assert.equal(item.text, '@bob please review');
    assert.equal(item.permalink, 'https://demo.slack.com/archives/permalink');
    assert.deepEqual(item.actor, {
      displayName: 'Alice',
      handle: 'alice',
      realName: 'Alice Lee',
      timezone: { label: 'China Standard Time', name: 'Asia/Shanghai', offsetSeconds: 28800 },
      userId: 'UALICE1',
    });
    assert.deepEqual(item.files, [{ id: 'F-shot', mimetype: 'image/png', name: 'shot.png', sizeBytes: 2048 }]);
    // No Slack permalink in the text -> the containing message is never re-read.
    assert.deepEqual(calls.history, []);
  });
});

test('buildSlackInboxItem decodes Slack HTML escapes into the agent-visible text', async () => {
  await withIngestHome(async () => {
    const calls = emptyCalls();
    const item = await buildSlackInboxItem({
      client: fakeIngestClient({ calls }),
      envelope: { team_id: 'T-ingest' },
      event: {
        channel: 'C-team',
        channel_type: 'channel',
        // Slack escapes `&`, `<`, `>`; a literal `&lt;` typed by the author
        // arrives double-escaped and must survive as typed.
        text: 'A &amp; B &lt;- C &gt; D, literal &amp;lt; stays',
        ts: '1770000010.000002',
        type: 'message',
        user: 'UALICE1',
      },
      warn: () => {},
    });
    assert.equal(item.text, 'A & B <- C > D, literal &lt; stays');
  });
});

test('buildSlackInboxItem uses the complete visible block body instead of truncated fallback text', async () => {
  await withIngestHome(async () => {
    const calls = emptyCalls();
    const item = await buildSlackInboxItem({
      client: fakeIngestClient({ calls }),
      envelope: { team_id: 'T-ingest' },
      event: {
        blocks: [
          {
            elements: [{
              elements: [
                { type: 'user', user_id: 'UB0B1' },
                { text: ' contract evidence', type: 'text' },
              ],
              type: 'rich_text_section',
            }],
            type: 'rich_text',
          },
          {
            rows: [
              [richTextCell('Contract'), richTextCell('Code')],
              [richTextCell('Conservation'), richTextCell('validateConservation')],
            ],
            type: 'table',
          },
          {
            elements: [{
              elements: [{ text: 'Full implementation tradeoff after the fallback cutoff.', type: 'text' }],
              type: 'rich_text_section',
            }],
            type: 'rich_text',
          },
        ],
        channel: 'C-team',
        channel_type: 'channel',
        text: '<@UB0B1> contract evidence…',
        ts: '1770000012.000001',
        type: 'message',
        user: 'UALICE1',
      },
      warn: () => {},
    });

    assert.match(item.text, /^@bob contract evidence/);
    assert.match(item.text, /\| Contract \| Code \|/);
    assert.match(item.text, /Full implementation tradeoff after the fallback cutoff\.$/);
    assert.doesNotMatch(item.text, /evidence…$/);
    assert.ok(calls.usersInfo.includes('UB0B1'));
  });
});

test('buildSlackInboxItem keeps content after unsupported Slack blocks and elements', async () => {
  await withIngestHome(async () => {
    const calls = emptyCalls();
    const prefix = '界'.repeat(1_200);
    const tail = 'RECIPIENT TAIL SENTINEL';
    const fallback = slackMessageContentForText(`${prefix}\n${tail}`).text;
    assert.doesNotMatch(fallback, /RECIPIENT TAIL SENTINEL/);

    const item = await buildSlackInboxItem({
      client: fakeIngestClient({ calls }),
      envelope: { team_id: 'T-ingest' },
      event: {
        blocks: [
          richTextCell(prefix),
          { type: 'divider' },
          { type: 'header', text: { type: 'plain_text', text: 'Binding result' } },
          { type: 'future_control_block', elements: [{ type: 'button', value: 'approve' }] },
          {
            elements: [{
              elements: [
                { type: 'text', text: 'Before inline. ' },
                { type: 'future_inline', text: 'Unknown inline words. ' },
                { type: 'text', text: `After inline. ${tail}` },
              ],
              type: 'rich_text_section',
            }],
            type: 'rich_text',
          },
        ],
        channel: 'C-team',
        channel_type: 'channel',
        text: fallback,
        ts: '1770000012.000002',
        type: 'message',
        user: 'UALICE1',
      },
      warn: () => {},
    });

    assert.match(item.text, /---/);
    assert.match(item.text, /Binding result/);
    assert.match(item.text, /\[unsupported block: future_control_block\]/);
    assert.match(item.text, /Before inline\. Unknown inline words\. After inline\. RECIPIENT TAIL SENTINEL$/);
  });
});

test('buildSlackInboxItem makes the same Slack API calls for a mention without depending on order', async () => {
  await withIngestHome(async () => {
    const calls = emptyCalls();
    const item = await buildSlackInboxItem({
      client: fakeIngestClient({ calls }),
      envelope: { team_id: 'T-ingest' },
      event: {
        channel: 'C-team',
        channel_type: 'channel',
        text: '<@UB0B1> please check <#C0THER1|ops>',
        ts: '1770000015.000001',
        type: 'message',
        user: 'UALICE1',
      },
      warn: () => {},
    });

    assert.equal(item.text, '@bob please check #team');
    assert.deepEqual(new Set(calls.api), new Set([
      'chat.getPermalink',
      'conversations.info:C-team',
      'conversations.info:C0THER1',
      'users.info:UALICE1',
      'users.info:UB0B1',
    ]));
  });
});

function richTextCell(text: string): object {
  return {
    elements: [{ elements: [{ text, type: 'text' }], type: 'rich_text_section' }],
    type: 'rich_text',
  };
}

test('buildSlackInboxItem degrades to raw ids when every Slack lookup fails', async () => {
  await withIngestHome(async () => {
    const calls = emptyCalls();
    const warnings: string[] = [];
    const item = await buildSlackInboxItem({
      client: fakeIngestClient({ calls, failLookups: true }),
      envelope: { team_id: 'T-ingest' },
      event: {
        channel: 'C-team',
        channel_type: 'channel',
        text: 'ping <@UB0B1|bob-fallback> and <#C0THER1|ops>',
        ts: '1770000020.000001',
        type: 'message',
        user: 'UALICE1',
      },
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(item.actor, { userId: 'UALICE1' });
    assert.equal(item.channelName, undefined);
    assert.equal(item.permalink, undefined);
    // Failed mention lookups fall back to the raw ids.
    assert.equal(item.text, 'ping @UB0B1 and #C0THER1');
    assert.ok(warnings.some((message) => message.includes('permalink lookup failed')));
  });
});

test('buildSlackInboxItem keeps Slack-provided unfurl previews without any message re-read', async () => {
  await withIngestHome(async () => {
    const calls = emptyCalls();
    const link = 'https://demo.slack.com/archives/C0PRIVATE1/p1770000100000001';
    const item = await buildSlackInboxItem({
      client: fakeIngestClient({ calls }),
      envelope: { team_id: 'T-ingest' },
      event: {
        attachments: [{
          author_name: 'Iris',
          channel_id: 'C0PRIVATE1',
          files: [{
            id: 'F-unfurled-html',
            mimetype: 'text/plain',
            name: 'curriculum.html',
            permalink: 'https://demo.slack.com/files/U-author/F-unfurled-html/curriculum.html',
            size: 35578,
            url_private: 'https://files.slack.com/private/F-unfurled-html',
            url_private_download: 'https://files.slack.com/private/F-unfurled-html/download',
          }],
          from_url: link,
          is_msg_unfurl: true,
          private_channel_prompt: true,
          text: 'Preview delivered by Slack',
          ts: '1770000100.000001',
        }],
        channel: 'D-owner',
        channel_type: 'im',
        text: `<${link}> can you see this?`,
        ts: '1770000200.000001',
        type: 'message',
        user: 'UALICE1',
      },
      warn: () => {},
    });

    assert.deepEqual(item.previews, [{
      authorName: 'Iris',
      channelId: 'C0PRIVATE1',
      files: [{
        id: 'F-unfurled-html',
        mimetype: 'text/plain',
        name: 'curriculum.html',
        permalink: 'https://demo.slack.com/files/U-author/F-unfurled-html/curriculum.html',
        sizeBytes: 35578,
      }],
      fromUrl: link,
      isPrivate: true,
      messageTs: '1770000100.000001',
      text: 'Preview delivered by Slack',
    }]);
    assert.equal(Object.hasOwn(item.previews?.[0]?.files?.[0] ?? {}, 'urlPrivate'), false);
    // Privacy boundary: the unfurl came with the event, so nothing is fetched —
    // in particular never the linked private channel.
    assert.deepEqual(calls.history, []);
  });
});

test('buildSlackInboxItem re-reads only the containing message for late unfurls, never the linked channel', async () => {
  await withIngestHome(async () => {
    const link = 'https://demo.slack.com/archives/C0PRIVATE1/p1770000100000001';
    const calls = emptyCalls();
    const item = await buildSlackInboxItem({
      client: fakeIngestClient({
        calls,
        historyAttachments: [{
          channel_id: 'C0PRIVATE1',
          from_url: link,
          is_msg_unfurl: true,
          text: 'Preview delivered by Slack shortly after the event',
          ts: '1770000100.000001',
        }],
      }),
      envelope: { team_id: 'T-ingest' },
      event: {
        channel: 'D-owner',
        channel_type: 'im',
        text: `<${link}> can you see this?`,
        ts: '1770000200.000001',
        type: 'message',
        user: 'UALICE1',
      },
      warn: () => {},
    });

    assert.equal(item.previews?.length, 1);
    assert.equal(item.previews?.[0]?.text, 'Preview delivered by Slack shortly after the event');
    // Privacy boundary: every history read targets the containing message; the
    // linked channel id from the permalink is never queried.
    assert.ok(calls.history.length >= 1);
    for (const call of calls.history) {
      assert.equal(call.channel, 'D-owner');
      assert.equal(call.latest, '1770000200.000001');
      assert.equal(call.oldest, '1770000200.000001');
    }
  });
});

const sharedLink = 'https://demo.slack.com/archives/C0PRIVATE1/p1770000100000001';
const linkEvent = {
  attachments: [{ fallback: 'ordinary attachment must not suppress lookup' }],
  channel: 'D-owner',
  channel_type: 'im',
  text: `<${sharedLink}> can you see this?`,
  ts: '1770000300.000001',
  type: 'message' as const,
  user: 'UALICE1',
};
const previewAttachment = {
  channel_id: 'C0PRIVATE1', from_url: sharedLink, is_msg_unfurl: true,
  text: 'Late shared preview', ts: '1770000100.000001',
};

test('ingest holds enqueue until preview completes, then an immediate claim contains it; duplicates stay deduped', { timeout: 3_000 }, async () => {
  await withIngestHome(async () => {
    const calls = emptyCalls();
    const client = fakeIngestClient({ calls });
    let finishLookup!: () => void;
    const held = new Promise<void>((resolve) => { finishLookup = resolve; });
    let lookupStarted!: () => void;
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    client.conversations.history = async (args) => {
      calls.history.push(args);
      if (calls.history.length === 1) return { ok: true, messages: [] };
      lookupStarted();
      await held;
      return { ok: true, messages: [{ ts: linkEvent.ts, attachments: [previewAttachment] }] };
    };
    const queue = new WakeQueueService('anima');
    let enrichCount = 0;
    const ingest = () => runIngestPipeline({
      agentId: 'anima',
      itemId: 'slack:T-ingest:D-owner:' + linkEvent.ts,
      decide: async ({ duplicate }) => ({ shouldStartRuntime: !duplicate, reason: 'dm' }),
      enrich: async () => {
        enrichCount++;
        return buildSlackInboxItem({
          client, envelope: { team_id: 'T-ingest' }, event: linkEvent,
          previewRetryDelaysMs: [0, 0], warn: () => {},
        });
      },
      queue,
      surfaceLog: () => ({}),
    });
    const pending = ingest();
    await Promise.race([
      started,
      pending.then(() => { throw new Error('wake was published before preview retry'); }),
    ]);
    assert.equal(await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'worker-1' }), undefined);
    finishLookup();
    await pending;
    const claimed = await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'worker-1' });
    assert.equal(claimed?.kind, 'slack');
    if (claimed?.kind !== 'slack') throw new Error('missing Slack item');
    assert.equal(claimed.previews?.[0]?.text, 'Late shared preview');
    assert.equal(claimed.previewStatus, undefined);
    assert.match(buildCodeAgentDeliveryPrompt(claimed), /Late shared preview/);
    await ingest();
    assert.equal(enrichCount, 1);
    assert.equal(await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'worker-2' }), undefined);
    assert.equal(calls.history.length, 2);
    for (const call of calls.history) {
      assert.equal(call.channel, 'D-owner');
      assert.equal(call.latest, linkEvent.ts);
      assert.equal(call.oldest, linkEvent.ts);
    }
  });
});

test('subscriber waits for the production preview client before publishing a claimable wake', async () => {
  await withTempAnimaHome(async (home) => {
    await writeAgentConfigs(home);
    let finish!: () => void;
    let started!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { started = resolve; });
    const requests: Array<{ url?: string; body: string }> = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        requests.push({ url: request.url, body });
        finish = () => {
          if (!response.writableEnded) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            ok: true, messages: [{ ts: linkEvent.ts, attachments: [previewAttachment] }],
          }));
        };
        started();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const previousUrl = process.env.ANIMA_SLACK_API_URL;
    process.env.ANIMA_SLACK_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
    const queue = new WakeQueueService('anima');
    const subscriber = Object.create(SlackInboxSubscriber.prototype) as Record<string, unknown>;
    subscriber['options'] = { agentRuntimeKind: 'codex-cli', botToken: 'test-only-token', botUserId: 'U-bot', queue };
    subscriber['slackProfiles'] = new SlackProfileResolver();
    subscriber['botDisplayInfoSyncInFlight'] = true;
    const handle = () => (subscriber as unknown as {
      handleSlackEvent(body: unknown, event: unknown, client: WebClient): Promise<void>;
    }).handleSlackEvent({ team_id: 'T-ingest' }, linkEvent, fakeIngestClient({ calls: emptyCalls() }));
    let pending: Promise<void> | undefined;
    try {
      pending = handle();
      await withTimeout(lookupStarted, 5_000);
      assert.equal(await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'fast-worker' }), undefined);
      finish();
      await pending;
      const claimed = await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'fast-worker' });
      assert.equal(claimed?.kind, 'slack');
      if (claimed?.kind === 'slack') assert.equal(claimed.previews?.[0]?.text, 'Late shared preview');
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.url, '/api/conversations.history');
      const body = new URLSearchParams(requests[0]?.body);
      assert.equal(body.get('channel'), 'D-owner');
      assert.equal(body.get('oldest'), linkEvent.ts);
      assert.equal(body.get('latest'), linkEvent.ts);
    } finally {
      finish?.();
      // Join ingress before deleting its scoped home, including on assertion failure.
      await pending;
      if (previousUrl === undefined) delete process.env.ANIMA_SLACK_API_URL;
      else process.env.ANIMA_SLACK_API_URL = previousUrl;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test('hanging preview request times out before enqueue; late results cannot mutate the delivered item', async () => {
  await withIngestHome(async () => {
    const client = fakeIngestClient({ calls: emptyCalls() });
    let resolveLookup!: (value: Awaited<ReturnType<typeof client.conversations.history>>) => void;
    client.conversations.history = (() => new Promise((resolve) => { resolveLookup = resolve; })) as typeof client.conversations.history;
    const startedAt = performance.now();
    const item = await buildSlackInboxItem({
      client, envelope: { team_id: 'T-ingest' }, event: linkEvent,
      previewTimeoutMs: 30, previewRetryDelaysMs: [0, 0], warn: () => {},
    });
    assert.ok(performance.now() - startedAt < 1_000);
    assert.equal(item.previewStatus, 'unavailable');
    assert.equal(item.text, linkEvent.text);
    const parsed = SlackInboxItem.parse(item);
    assert.equal(parsed.previewStatus, 'unavailable');
    assert.match(buildCodeAgentDeliveryPrompt(parsed), /Preview not yet obtained/);
    assert.match(renderSlackCursorExtras(parsed), /status="unavailable"/);
    const queue = new WakeQueueService('anima');
    assert.equal((await queue.enqueue(item)).queued, true);
    resolveLookup({ ok: true, messages: [{ ts: linkEvent.ts, attachments: [previewAttachment] }] });
    await new Promise((resolve) => setImmediate(resolve));
    const claimed = await queue.takeNextRunnable({ isWorkerAlive: () => true, workerId: 'worker-1' });
    assert.equal(claimed?.kind, 'slack');
    if (claimed?.kind === 'slack') {
      assert.equal(claimed.previewStatus, 'unavailable');
      assert.equal(claimed.previews, undefined);
    }
  });
});

test('ordinary messages and already attached previews do not create a preview client or wait', async () => {
  await withIngestHome(async () => {
    for (const event of [
      { ...linkEvent, text: 'plain message', attachments: undefined },
      { ...linkEvent, attachments: [previewAttachment] },
    ]) {
      const calls = emptyCalls();
      const item = await buildSlackInboxItem({
        client: fakeIngestClient({ calls }), event,
        previewClient: () => { throw new Error('unexpected preview client'); },
        warn: () => {},
      });
      assert.deepEqual(calls.history, []);
      assert.equal(item.previewStatus, undefined);
    }
  });
});

test('the Slack app skips its own auth.test only when start passes both bot ids', async () => {
  const authTestTokens: string[] = [];
  const slackApi = await startSlackApiMock((method, _body, request) => {
    if (method !== 'auth.test') throw new Error(`unexpected Slack API method ${method}`);
    authTestTokens.push(bearerToken(request));
    return { ok: true, bot_id: 'B-bot', user_id: 'U-bot' };
  });
  const previousUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = slackApi.url;
  try {
    const options = { agentRuntimeKind: 'codex-cli', appToken: 'xapp-test-only', queue: new WakeQueueService('anima') };
    // Bolt sends its auth.test from the constructor; none of these is started.
    new SlackInboxSubscriber({ ...options, botId: 'B-bot', botToken: 'xoxb-both-ids', botUserId: 'U-bot' });
    new SlackInboxSubscriber({ ...options, botToken: 'xoxb-user-id-only', botUserId: 'U-bot' });
    new SlackInboxSubscriber({ ...options, botId: 'B-bot', botToken: 'xoxb-bot-id-only' });
    for (let waited = 0; waited < 2_000 && authTestTokens.length < 2; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // All three constructors ran in the same tick, so a call from the first
    // would have arrived with the other two.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(authTestTokens.sort(), ['xoxb-bot-id-only', 'xoxb-user-id-only']);
  } finally {
    if (previousUrl === undefined) delete process.env.ANIMA_SLACK_API_URL;
    else process.env.ANIMA_SLACK_API_URL = previousUrl;
    await slackApi.close();
  }
});

test('an agent start that Slack rejects leaves queued work unclaimed', async (t) => withTempAnimaHome(async (home) => {
  t.mock.method(console, 'error', () => {});
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  const queue = new WakeQueueService('scout');
  const queued = makeSlackEvent({ channelId: 'D-scout', teamId: 'T-demo', text: 'queued before restart', userId: 'U-human' });
  await queue.enqueue(queued);
  let runs = 0;
  let connectionOpens = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const method = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\/api\//, '');
      const reply = (body: object) => {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      if (method !== 'apps.connections.open') {
        reply({ ok: true });
        return;
      }
      connectionOpens += 1;
      // Hold the rejection long enough for a worker started first to claim the item.
      const heldAt = Date.now();
      const hold = setInterval(() => {
        if (runs === 0 && Date.now() - heldAt < 500) return;
        clearInterval(hold);
        reply({ error: 'invalid_auth', ok: false });
      }, 10);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previousUrl = process.env.ANIMA_SLACK_API_URL;
  process.env.ANIMA_SLACK_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    await assert.rejects(startRunningAgent({
      agentId: 'scout',
      agentRuntime: {
        async appendToActiveRun() { return { accepted: false }; },
        kind: 'counting',
        async run() {
          runs += 1;
          return { text: 'done' };
        },
      },
      animaHome: home,
      appToken: 'xapp-rejected',
      botId: 'B-scout',
      botToken: 'xoxb-scout',
      botUserId: 'U-scout',
      homePath: join(home, 'agent-homes', 'scout'),
      runLimiter: new TeamRunLimiter(),
      runtimeEnv: {},
      stateDir: home,
    }), /apps\.connections\.open failed: .*invalid_auth/);
    assert.equal(connectionOpens, 1);
    assert.equal(runs, 0, 'the provider never ran');
    assert.deepEqual((await queue.list()).map((item) => [item.id, item.handling.status]), [[queued.id, 'queued']]);
  } finally {
    if (previousUrl === undefined) delete process.env.ANIMA_SLACK_API_URL;
    else process.env.ANIMA_SLACK_API_URL = previousUrl;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}));

test('running agent exposes Slack connection state through persisted health and copied diagnostics', async (t) => withTempAnimaHome(async (home) => {
  const { SocketModeClient } = await import('@slack/socket-mode');
  const { AgentHealthStore } = await import('../runtime/agent-health.store.js');
  const { buildAgentDiagnostics } = await import('../diagnostics/agent-diagnostics.service.js');
  const { waitFor } = await import('./helpers/harness.js');
  await writeAgentConfigs(home, [defaultAgentConfig('scout')]);
  let client: InstanceType<typeof SocketModeClient> | undefined;
  let fail = false;
  t.mock.method(SocketModeClient.prototype, 'start', async function(this: InstanceType<typeof SocketModeClient>) {
    client = this;
    if (fail) throw Object.assign(new Error('synthetic-private-request-body'), {
      code: 'slack_webapi_platform_error', data: { error: 'account_inactive' },
    });
    return undefined;
  });
  t.mock.method(SocketModeClient.prototype, 'disconnect', async () => {});
  t.mock.method(console, 'error', () => {});
  const handle = await startRunningAgent({
    agentId: 'scout', agentRuntime: { kind: 'synthetic', async appendToActiveRun() { return { accepted: false }; }, async run() { return { text: 'done' }; } },
    animaHome: home, appToken: 'xapp-synthetic', botToken: 'xoxb-synthetic', botId: 'B-scout', botUserId: 'U-scout',
    homePath: join(home, 'agent-homes', 'scout'), runLimiter: new TeamRunLimiter(), runtimeEnv: {}, stateDir: home,
  });
  try {
    assert.equal(handle.health!().transports?.slack?.state, 'connected');
    fail = true;
    assert.ok(client);
    client.emit('disconnected');
    await waitFor(() => handle.health!().transports?.slack?.state === 'failed');
    const current = handle.health!();
    assert.equal(current.transports?.slack?.reason, 'account_inactive');
    assert.ok(current.transports?.slack?.disconnectedAt);
    const healthStore = new AgentHealthStore({ animaHome: home });
    await healthStore.update('scout', () => ({ state: 'healthy', updatedAt: new Date().toISOString(), runtime: current }));
    assert.deepEqual((await new AgentHealthStore({ animaHome: home }).get('scout'))?.runtime?.transports, current.transports);
    const diagnostics = await buildAgentDiagnostics('scout');
    assert.deepEqual(diagnostics.status.health?.runtime?.transports, current.transports);
    assert.equal(diagnostics.status.health?.state, 'healthy', 'Slack connectivity does not restart a healthy provider');
    assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-private-request-body|xapp-synthetic|xoxb-synthetic/);
    await handle.stop();
    assert.equal(handle.health!().transports?.slack?.state, 'stopped');
    await healthStore.update('scout', () => ({ state: 'healthy', updatedAt: new Date().toISOString(), runtime: { providerChildExpected: false } }));
    assert.equal((await healthStore.get('scout'))?.runtime?.transports, undefined, 'older snapshots remain readable');
  } finally { await handle.stop(); }
}));
