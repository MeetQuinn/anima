import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebClient } from '@slack/web-api';

import { buildSlackInboxItem, buildSlackInboxItemWithLatePreview } from '../inbox/slack-ingest.js';
import { applyLateSlackPreviewToQueuedItem } from '../inbox/slack-subscriber.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { slackMessageContentForText } from '../tools/slack-message-format.js';
import { withAnimaHome } from './anima-home.js';

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

test('Slack ingest enqueue does not wait for the delayed unfurl retry ladder', async () => {
  await withIngestHome(async () => {
    const link = 'https://demo.slack.com/archives/C0PRIVATE1/p1770000100000001';
    const calls = emptyCalls();
    const client = fakeIngestClient({ calls });
    client.conversations.history = async () => new Promise(() => {});

    const result = await buildSlackInboxItemWithLatePreview({
      client,
      envelope: { team_id: 'T-ingest' },
      event: {
        attachments: [{ fallback: 'ordinary attachment' }],
        channel: 'D-owner',
        channel_type: 'im',
        text: `<${link}> can you see this?`,
        ts: '1770000300.000001',
        type: 'message',
        user: 'UALICE1',
      },
      warn: () => {},
    });
    assert.ok(result.latePreview);

    const queue = new WakeQueueService('anima');
    const decision = await queue.enqueue(result.item);

    assert.equal(decision.queued, true);
    assert.equal((await queue.find(result.item.id))?.id, result.item.id);
  });
});

test('late Slack previews replace queued items and leave claimed items untouched', async () => {
  await withIngestHome(async () => {
    const queuedQueue = new WakeQueueService('anima');
    const queuedItem = await buildSlackInboxItem({
      client: fakeIngestClient({ calls: emptyCalls() }),
      envelope: { team_id: 'T-ingest' },
      event: {
        channel: 'D-owner',
        channel_type: 'im',
        text: 'queued preview',
        ts: '1770000400.000001',
        type: 'message',
        user: 'UALICE1',
      },
      warn: () => {},
    });
    await queuedQueue.enqueue(queuedItem);
    await applyLateSlackPreviewToQueuedItem({
      item: queuedItem,
      latePreview: async (item) => ({
        ...item,
        previews: [{ text: 'late preview while queued' }],
      }),
      queue: queuedQueue,
    });
    const updatedQueuedItem = await queuedQueue.find(queuedItem.id);
    assert.equal(updatedQueuedItem?.kind, 'slack');
    assert.deepEqual(updatedQueuedItem.previews, [{ text: 'late preview while queued' }]);
    await queuedQueue.complete(queuedItem.id);

    const claimedQueue = new WakeQueueService('anima');
    let runningItemId: string | undefined;
    const claimedItem = await buildSlackInboxItem({
      client: fakeIngestClient({ calls: emptyCalls() }),
      envelope: { team_id: 'T-ingest' },
      event: {
        channel: 'D-owner',
        channel_type: 'im',
        text: 'claimed preview',
        ts: '1770000500.000001',
        type: 'message',
        user: 'UALICE1',
      },
      warn: () => {},
    });
    await claimedQueue.enqueue(claimedItem);

    await applyLateSlackPreviewToQueuedItem({
      item: claimedItem,
      latePreview: async (item) => ({
        ...item,
        previews: [{ text: 'late preview after claim' }],
      }),
      queue: {
        replaceQueuedItem: async (item) => {
          const running = await claimedQueue.takeNextRunnable({
            isWorkerAlive: () => true,
            workerId: 'worker-1',
          });
          runningItemId = running?.id;
          return claimedQueue.replaceQueuedItem(item);
        },
      },
    });
    assert.equal(runningItemId, claimedItem.id);
    const updatedClaimedItem = await claimedQueue.find(claimedItem.id);
    assert.equal(updatedClaimedItem?.kind, 'slack');
    assert.equal(updatedClaimedItem.handling.status, 'running');
    assert.equal(updatedClaimedItem.previews, undefined);

    await claimedQueue.complete(claimedItem.id);
    await applyLateSlackPreviewToQueuedItem({
      item: claimedItem,
      latePreview: async (item) => ({
        ...item,
        previews: [{ text: 'late preview after settle' }],
      }),
      queue: claimedQueue,
    });
    assert.equal(await claimedQueue.find(claimedItem.id), undefined);
  });
});
