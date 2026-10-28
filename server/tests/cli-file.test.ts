import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeSlackAgentConfig } from './helpers/harness.js';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { allActivities, loadState } from './helpers/state.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import { makeSlackEvent } from './helpers/slack.js';
import { readHttpBody, slackRequestBody, startSlackApiMock } from './helpers/slack-api.js';
import { ingestEvent } from './helpers/inbox.js';
import { withAnimaHome } from './anima-home.js';
import { runNode } from './helpers/run-node.js';
import { slackMarkdownBlockText } from '../tools/slack-message-format.js';

const cliPath = resolve('dist/server/cli/anima.js');

test('file send uploads a local file and records an audited Slack output', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-send-test-'));
  const uploadUrls: string[] = [];
  const completeCalls: Array<Record<string, unknown>> = [];
  const uploadServerPosts: string[] = [];

  const uploadServer = createServer((request, response) => {
    void readHttpBody(request).then((body) => {
      uploadServerPosts.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  uploadServer.listen(0, '127.0.0.1');
  await once(uploadServer, 'listening');
  const uploadAddr = uploadServer.address();
  if (!uploadAddr || typeof uploadAddr === 'string') throw new Error('upload server not bound');

  let getUploadCount = 0;
  let infoCount = 0;
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'files.getUploadURLExternal') {
      getUploadCount += 1;
      const uploadUrl = `http://127.0.0.1:${uploadAddr.port}/upload/${getUploadCount}`;
      uploadUrls.push(uploadUrl);
      return { ok: true, file_id: `F-test-${getUploadCount}`, upload_url: uploadUrl };
    }
    if (method === 'files.completeUploadExternal') {
      completeCalls.push(slackRequestBody(body));
      return {
        ok: true,
        files: [{ id: 'F-test-1', title: 'screenshot.png' }],
      };
    }
    if (method === 'files.info') {
      infoCount += 1;
      return {
        ok: true,
        file: {
          id: 'F-test-1',
          mimetype: 'image/png',
          name: 'screenshot.png',
          permalink: 'https://anima.slack.com/files/U-scout/F-test-1/screenshot.png',
          size: 12,
          thumb_360: 'https://files.slack.com/secure/F-test-1/thumb_360.png',
          thumb_720: 'https://files.slack.com/secure/F-test-1/thumb_720.png',
          // Slack reports an image's message only after processing it: not on
          // the first read right after completeUploadExternal.
          ...(infoCount > 1 ? sharedIn('C-product', '1770000300.000200') : {}),
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const localPath = join(stateDir, 'screenshot.png');
      await writeFile(localPath, Buffer.from('fake-png-bytes'));

      const send = await runNode(
        [cliPath, 'file', 'send', '--channel', 'C-product', localPath],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_INBOX_ITEM_ID: itemId,
            ANIMA_SLACK_API_URL: slackApi.url,
          },
        },
      );
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.equal(send.stdout.trim(), 'uploaded successfully. channel=#product, message_ts=1770000300.000200, files=1.');
      assert.equal(infoCount, 2, 'waited for the share ts after the first read lacked it');

      // Slack upload POST happened
      assert.equal(uploadUrls.length, 1);
      assert.equal(uploadServerPosts.length, 1);

      // completeUploadExternal got the single file id and channel
      assert.equal(completeCalls.length, 1);
      const complete = completeCalls[0]!;
      assert.equal(complete['channel_id'], 'C-product');
      const completeFiles = parseFilesField(complete['files']);
      assert.equal(completeFiles.length, 1);
      assert.equal(completeFiles[0]?.id, 'F-test-1');

      // Audit completed activity
      const activities = await activitiesForInboxItemWindow('scout', itemId);
      const completed = activities.at(-1);
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'slack.file.send');
      assert.equal(completed?.payload?.['tool'], 'anima.file.send');
      assert.equal(completed?.payload?.['status'], 'sent');
      assert.equal(completed?.payload?.['fileCount'], 1);
      assert.equal(completed?.payload?.['channelDisplayName'], '#product');
      const uploads = completed?.payload?.['uploads'] as Array<Record<string, unknown>>;
      assert.equal(uploads.length, 1);
      assert.equal(uploads[0]?.['fileId'], 'F-test-1');
      assert.equal(uploads[0]?.['filename'], 'screenshot.png');
      assert.equal(uploads[0]?.['mimetype'], 'image/png');
      assert.equal(uploads[0]?.['permalink'], 'https://anima.slack.com/files/U-scout/F-test-1/screenshot.png');
      assert.equal(uploads[0]?.['thumb360'], 'https://files.slack.com/secure/F-test-1/thumb_360.png');
      assert.equal(uploads[0]?.['messageId'], '1770000300.000200');
      assert.equal(completed?.payload?.['ts'], '1770000300.000200');

      // A top-level file post follows its own thread, like a message post, so
      // replies under it wake the agent without a mention.
      assert.deepEqual(completed?.payload?.['threadSubscription'], {
        subscriptionId: 'slack-subscription:scout:C-product:thread:1770000300.000200',
        kind: 'thread',
        threadTs: '1770000300.000200',
      });
      const state = await loadState();
      assert.ok(Object.values(state.subscriptions).some(
        (subscription) => subscription.kind === 'thread' && subscription.threadTs === '1770000300.000200',
      ));
    });
  } finally {
    await slackApi.close();
    uploadServer.close();
    await once(uploadServer, 'close');
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('file send supports multi-file batch with caption and thread', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-batch-test-'));
  const completeCalls: Array<Record<string, unknown>> = [];

  const uploadServer = createServer((_request, response) => {
    response.writeHead(200);
    response.end();
  });
  uploadServer.listen(0, '127.0.0.1');
  await once(uploadServer, 'listening');
  const uploadAddr = uploadServer.address();
  if (!uploadAddr || typeof uploadAddr === 'string') throw new Error('upload server not bound');

  let getUploadCount = 0;
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return { channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' }, ok: true };
    }
    if (method === 'files.getUploadURLExternal') {
      getUploadCount += 1;
      return {
        ok: true,
        file_id: `F-batch-${getUploadCount}`,
        upload_url: `http://127.0.0.1:${uploadAddr.port}/upload/${getUploadCount}`,
      };
    }
    if (method === 'files.completeUploadExternal') {
      completeCalls.push(slackRequestBody(body));
      return {
        ok: true,
        files: [
          { id: 'F-batch-1', ...sharedIn('C-product', '1770000200.000300', '1770000200.000001') },
          { id: 'F-batch-2', ...sharedIn('C-product', '1770000200.000300', '1770000200.000001') },
        ],
      };
    }
    if (method === 'files.info') {
      return { ok: true, file: { id: 'F-batch-1', mimetype: 'image/png', size: 8, permalink: 'https://anima.slack.com/files/F-batch-1' } };
    }
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const a = join(stateDir, 'a.png');
      const b = join(stateDir, 'b.txt');
      await writeFile(a, Buffer.from('aaaa'));
      await writeFile(b, Buffer.from('bbbb'));

      const send = await runNode(
        [cliPath, 'file', 'send', '--channel', 'C-product', '--thread-ts', '1770000200.000001', '--caption', 'see attached', a, b],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_INBOX_ITEM_ID: itemId,
            ANIMA_SLACK_API_URL: slackApi.url,
          },
        },
      );
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.equal(
        send.stdout.trim(),
        'uploaded successfully. channel=#product, thread_ts=1770000200.000001, message_ts=1770000200.000300, files=2.',
      );

      assert.equal(completeCalls.length, 1);
      const complete = completeCalls[0]!;
      assert.deepEqual(captionBlocks(complete), [{ type: 'markdown', text: 'see attached' }]);
      assert.equal(complete['thread_ts'], '1770000200.000001');
      const files = parseFilesField(complete['files']);
      assert.equal(files.length, 2);

      const completed = (await activitiesForInboxItemWindow('scout', itemId)).at(-1);
      assert.equal(completed?.payload?.['fileCount'], 2);
      assert.equal(completed?.payload?.['caption'], 'see attached');
      assert.equal(completed?.payload?.['threadTs'], '1770000200.000001');
      assert.equal(completed?.payload?.['ts'], '1770000200.000300');
      const uploads = completed?.payload?.['uploads'] as Array<Record<string, unknown>>;
      assert.deepEqual(uploads.map((upload) => upload['messageId']), ['1770000200.000300', '1770000200.000300']);
      assert.equal(
        (completed?.payload?.['threadSubscription'] as Record<string, unknown> | undefined)?.['threadTs'],
        '1770000200.000001',
      );
    });
  } finally {
    await slackApi.close();
    uploadServer.close();
    await once(uploadServer, 'close');
    await rm(stateDir, { force: true, recursive: true });
  }
});

// `message send --file` is the same file post as `file send`: one upload, the
// body as the caption, and a caption resolves readable mentions like a message.
test('message send --file posts files as one message with the body as a mention-resolved caption', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-message-file-test-'));
  const completeCalls: Array<Record<string, unknown>> = [];
  const uploadedBytes: string[] = [];
  let apiUrl = '';
  let getUploadCount = 0;
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'users.list') {
      return { members: [{ id: 'U0B68F373GU', is_bot: true, is_stranger: false, name: 'felix', team_id: 'T-demo' }], ok: true };
    }
    if (method === 'conversations.info') {
      return { channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' }, ok: true };
    }
    if (method === 'conversations.members') return { members: ['U0B68F373GU'], ok: true };
    if (method === 'files.getUploadURLExternal') {
      getUploadCount += 1;
      return { ok: true, file_id: `F-msg-${getUploadCount}`, upload_url: `${apiUrl}/upload-bytes/${getUploadCount}` };
    }
    if (method.startsWith('upload-bytes/')) {
      uploadedBytes.push(body);
      return { ok: true };
    }
    if (method === 'files.completeUploadExternal') {
      completeCalls.push(slackRequestBody(body));
      return {
        ok: true,
        files: [
          { id: 'F-msg-1', ...sharedIn('C-product', '1770000200.000400', '1770000200.000001') },
          { id: 'F-msg-2', ...sharedIn('C-product', '1770000200.000400', '1770000200.000001') },
        ],
      };
    }
    if (method === 'files.info') return { ok: true, file: { id: 'F-msg-1', mimetype: 'text/plain', size: 4 } };
    if (method === 'chat.postMessage') throw new Error('a file post must not also post a text message');
    throw new Error(`unexpected method ${method}`);
  });
  apiUrl = slackApi.url;

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);
      const a = join(stateDir, 'a.txt');
      const b = join(stateDir, 'b.txt');
      await writeFile(a, 'aaaa');
      await writeFile(b, 'bbbb');

      const send = await runNode(
        [cliPath, 'message', 'send', '--channel', 'C-product', '--thread-ts', '1770000200.000001', '--file', a, '--file', b],
        {
          env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir, ANIMA_INBOX_ITEM_ID: itemId, ANIMA_SLACK_API_URL: slackApi.url },
          input: 'For @felix: **both** logs',
        },
      );
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.equal(
        send.stdout.trim(),
        'uploaded successfully. channel=#product, thread_ts=1770000200.000001, message_ts=1770000200.000400, files=2.',
      );
      assert.deepEqual(uploadedBytes.sort(), ['aaaa', 'bbbb']);
      assert.equal(completeCalls.length, 1);
      assert.equal(completeCalls[0]!['thread_ts'], '1770000200.000001');
      assert.equal(parseFilesField(completeCalls[0]!['files']).length, 2);
      assert.deepEqual(captionBlocks(completeCalls[0]!), [{ type: 'markdown', text: 'For <@U0B68F373GU>: **both** logs' }]);

      const completed = (await activitiesForInboxItemWindow('scout', itemId)).at(-1);
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'slack.file.send');
      assert.equal(completed?.payload?.['tool'], 'anima.file.send');
      assert.equal(completed?.payload?.['fileCount'], 2);
      assert.equal(completed?.payload?.['caption'], 'For @felix: **both** logs');
      assert.equal(completed?.payload?.['slackCaption'], 'For <@U0B68F373GU>: **both** logs');
      assert.deepEqual(completed?.payload?.['resolvedMentions'], [{ id: 'U0B68F373GU', label: '@felix', type: 'user' }]);
      assert.equal(completed?.payload?.['warnings'], undefined);
      assert.equal(completed?.payload?.['ts'], '1770000200.000400');
      assert.equal(
        (completed?.payload?.['threadSubscription'] as Record<string, unknown> | undefined)?.['threadTs'],
        '1770000200.000001',
      );
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

// The seam this case guards is what reaches Slack, so it asserts the outgoing
// `blocks` on the wire. The mock answers 200 to anything and validates nothing;
// it cannot tell us Slack renders the result. That half is a real-Slack probe,
// recorded on the PR: a markdown block in files.completeUploadExternal renders
// a mention, a channel link, a labelled URL, a bullet list and CJK-adjacent bold
// in one caption. This half locks in that every caption takes that one path and
// what the audit trail records.
test('file send posts captions as one Slack markdown block, entities and Markdown together', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-caption-block-test-'));
  const completeCalls: Array<Record<string, unknown>> = [];

  const uploadServer = createServer((_request, response) => {
    response.writeHead(200);
    response.end();
  });
  uploadServer.listen(0, '127.0.0.1');
  await once(uploadServer, 'listening');
  const uploadAddr = uploadServer.address();
  if (!uploadAddr || typeof uploadAddr === 'string') throw new Error('upload server not bound');

  let getUploadCount = 0;
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return { channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' }, ok: true };
    }
    if (method === 'files.getUploadURLExternal') {
      getUploadCount += 1;
      return {
        ok: true,
        file_id: `F-cap-${getUploadCount}`,
        upload_url: `http://127.0.0.1:${uploadAddr.port}/upload/${getUploadCount}`,
      };
    }
    // A caption's mentions get the same membership check as a message's.
    if (method === 'conversations.members') return { members: ['U0B3ZB0NCLA'], ok: true };
    if (method === 'files.completeUploadExternal') {
      completeCalls.push(slackRequestBody(body));
      return { ok: true, files: [{ id: `F-cap-${getUploadCount}` }] };
    }
    if (method === 'files.info') {
      return { ok: true, file: { id: `F-cap-${getUploadCount}`, mimetype: 'image/png', size: 4, ...sharedIn('C-product', `1770000400.00000${getUploadCount}`) } };
    }
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);
      const png = join(stateDir, 'shot.png');
      await writeFile(png, Buffer.from('aaaa'));

      const send = async (caption: string) => runNode(
        [cliPath, 'file', 'send', '--channel', 'C-product', '--caption', caption, png],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_INBOX_ITEM_ID: itemId,
            ANIMA_SLACK_API_URL: slackApi.url,
          },
        },
      );
      const sent = async (caption: string) => {
        const result = await send(caption);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const complete = completeCalls.at(-1)!;
        assert.ok(!('initial_comment' in complete), 'initial_comment would make Slack ignore blocks');
        return { complete, audit: (await activitiesForInboxItemWindow('scout', itemId)).at(-1) };
      };

      // The reported shape: a mention plus GFM. Before, any `<` sent the caption
      // as raw mrkdwn, so `**` and `- ` showed literally.
      const mixed = '<@U0B3ZB0NCLA> 视频做好了，**4:55**。\n\n- **讲法**：三个主题\n- **字幕**：英文';
      const reported = await sent(mixed);
      assert.deepEqual(captionBlocks(reported.complete), [{ type: 'markdown', text: slackMarkdownBlockText(mixed) }]);
      assert.match(captionBlocks(reported.complete)[0]!.text, /^<@U0B3ZB0NCLA> /);
      assert.match(captionBlocks(reported.complete)[0]!.text, /\n- \*\*讲法\*\*/);
      assert.equal(reported.audit?.payload?.['caption'], mixed);

      // #541's entity forms reach Slack byte-for-byte inside the block.
      const entities = 'cc <@U0B3ZB0NCLA> in <#C0B8U0ZR2AW|code-review>: <https://example.com|Docs>';
      const kept = await sent(entities);
      assert.deepEqual(captionBlocks(kept.complete), [{ type: 'markdown', text: entities }]);
      // Nothing was transformed, so there is no second form to record.
      assert.equal(kept.audit?.payload?.['caption'], entities);
      assert.equal(kept.audit?.payload?.['slackCaption'], undefined);

      // Captions share the message transform, so a URL glued to CJK punctuation
      // is wrapped to link. The audit records the form Slack actually received.
      const glued = '预览：https://example.com/a，看一下';
      const linked = await sent(glued);
      assert.equal(captionBlocks(linked.complete)[0]!.text, '预览：<https://example.com/a>，看一下');
      assert.equal(linked.audit?.payload?.['caption'], glued);
      assert.equal(linked.audit?.payload?.['slackCaption'], '预览：<https://example.com/a>，看一下');

      // A whitespace-only caption posts no caption at all. The audit has to say
      // so, rather than assert a caption that was never posted.
      const blank = await sent('   ');
      assert.ok(!('blocks' in blank.complete));
      assert.equal(blank.audit?.payload?.['caption'], '   ');
      assert.equal(blank.audit?.payload?.['slackCaption'], '');

      // An over-long caption fails before any upload URL or bytes.
      const uploadsBefore = getUploadCount;
      const callsBefore = completeCalls.length;
      const tooLong = await send('x'.repeat(12_001));
      assert.notEqual(tooLong.status, 0);
      assert.match(tooLong.stderr + tooLong.stdout, /caption is too long for Slack markdown block: 12001 characters, Slack allows 12000; shorten it, or send the long text as a file/);
      assert.equal(getUploadCount, uploadsBefore);
      assert.equal(completeCalls.length, callsBefore);
    });
  } finally {
    await slackApi.close();
    uploadServer.close();
    await once(uploadServer, 'close');
    await rm(stateDir, { force: true, recursive: true });
  }
});

// Agent tool shells hand children an stdin pipe that is never written or closed.
// Without --caption the send must still complete (no caption) instead of blocking
// on stdin until the tool timeout kills it.
test('file send does not block on an idle stdin pipe when --caption is absent', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-idle-stdin-test-'));
  const completeCalls: Array<Record<string, unknown>> = [];

  const uploadServer = createServer((_request, response) => {
    response.writeHead(200);
    response.end();
  });
  uploadServer.listen(0, '127.0.0.1');
  await once(uploadServer, 'listening');
  const uploadAddr = uploadServer.address();
  if (!uploadAddr || typeof uploadAddr === 'string') throw new Error('upload server not bound');

  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return { channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' }, ok: true };
    }
    if (method === 'files.getUploadURLExternal') {
      return { ok: true, file_id: 'F-idle-1', upload_url: `http://127.0.0.1:${uploadAddr.port}/upload/1` };
    }
    if (method === 'files.completeUploadExternal') {
      completeCalls.push(slackRequestBody(body));
      return { ok: true, files: [{ id: 'F-idle-1' }] };
    }
    if (method === 'files.info') {
      return { ok: true, file: { id: 'F-idle-1', mimetype: 'image/png', size: 4, permalink: 'https://anima.slack.com/files/F-idle-1', ...sharedIn('C-product', '1770000500.000001') } };
    }
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);
      const localPath = join(stateDir, 'evidence.png');
      await writeFile(localPath, Buffer.from('img!'));

      const startedAt = Date.now();
      const send = await runNode(
        [cliPath, 'file', 'send', '--channel', 'C-product', localPath],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_INBOX_ITEM_ID: itemId,
            ANIMA_SLACK_API_URL: slackApi.url,
          },
          keepStdinOpen: true,
        },
      );
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.ok(Date.now() - startedAt < 30_000, 'send must not wait for stdin EOF');
      assert.equal(completeCalls.length, 1);
      assert.ok(!('blocks' in completeCalls[0]!));
      assert.ok(!('initial_comment' in completeCalls[0]!));
    });
  } finally {
    await slackApi.close();
    uploadServer.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('file send accepts caption from stdin when --caption is not passed', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-stdin-caption-test-'));
  const completeCalls: Array<Record<string, unknown>> = [];

  const uploadServer = createServer((_request, response) => {
    response.writeHead(200);
    response.end();
  });
  uploadServer.listen(0, '127.0.0.1');
  await once(uploadServer, 'listening');
  const uploadAddr = uploadServer.address();
  if (!uploadAddr || typeof uploadAddr === 'string') throw new Error('upload server not bound');

  let getUploadCount = 0;
  const slackApi = await startSlackApiMock((method, body) => {
    if (method === 'conversations.info') {
      return { channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' }, ok: true };
    }
    if (method === 'files.getUploadURLExternal') {
      getUploadCount += 1;
      return {
        ok: true,
        file_id: `F-stdin-${getUploadCount}`,
        upload_url: `http://127.0.0.1:${uploadAddr.port}/upload/${getUploadCount}`,
      };
    }
    if (method === 'files.completeUploadExternal') {
      completeCalls.push(slackRequestBody(body));
      return { ok: true, files: [{ id: 'F-stdin-1' }] };
    }
    if (method === 'files.info') {
      return { ok: true, file: { id: 'F-stdin-1', mimetype: 'image/png', size: 4, permalink: 'https://anima.slack.com/files/F-stdin-1', ...sharedIn('C-product', '1770000600.000001') } };
    }
    throw new Error(`unexpected method ${method}`);
  });

  // A caption that would be ruined by `bash -c "--caption \`anima file send\` ..."`:
  // backticks, $(), single + double quotes all live happily inside a heredoc.
  const captionWithShellMetachars = "uploaded via `anima file send` (cost: $(price) USD) — \"shipped\"";

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const localPath = join(stateDir, 'evidence.png');
      await writeFile(localPath, Buffer.from('img!'));

      const send = await runNode(
        [cliPath, 'file', 'send', '--channel', 'C-product', localPath],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_INBOX_ITEM_ID: itemId,
            ANIMA_SLACK_API_URL: slackApi.url,
          },
          input: captionWithShellMetachars,
        },
      );
      assert.equal(send.status, 0, send.stderr || send.stdout);

      // Caption survived shell-quoting hell because it never hit the shell.
      assert.equal(completeCalls.length, 1);
      const complete = completeCalls[0]!;
      assert.deepEqual(captionBlocks(complete), [{ type: 'markdown', text: captionWithShellMetachars }]);

      // Audit payload preserves the same caption string.
      const completed = (await activitiesForInboxItemWindow('scout', itemId)).at(-1);
      assert.equal(completed?.payload?.['caption'], captionWithShellMetachars);
    });
  } finally {
    await slackApi.close();
    uploadServer.close();
    await once(uploadServer, 'close');
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('file send records external.effect.failed when Slack rejects completeUploadExternal', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-complete-failure-test-'));

  const uploadServer = createServer((_request, response) => {
    response.writeHead(200);
    response.end();
  });
  uploadServer.listen(0, '127.0.0.1');
  await once(uploadServer, 'listening');
  const uploadAddr = uploadServer.address();
  if (!uploadAddr || typeof uploadAddr === 'string') throw new Error('upload server not bound');

  let completeCalls = 0;
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'conversations.info') {
      return { channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' }, ok: true };
    }
    if (method === 'files.getUploadURLExternal') {
      return {
        ok: true,
        file_id: 'F-fail-1',
        upload_url: `http://127.0.0.1:${uploadAddr.port}/upload/1`,
      };
    }
    if (method === 'files.completeUploadExternal') {
      completeCalls += 1;
      // Slack rejecting completion is the most user-visible failure mode:
      // bytes already POSTed, but the message never posts. The audit must
      // record `external.effect.failed` so users see why the file never
      // appeared in the channel.
      return { error: 'channel_not_found', ok: false };
    }
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const localPath = join(stateDir, 'doomed.png');
      await writeFile(localPath, Buffer.from('img!'));

      const send = await runNode(
        [cliPath, 'file', 'send', '--channel', 'C-product', localPath],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_INBOX_ITEM_ID: itemId,
            ANIMA_SLACK_API_URL: slackApi.url,
          },
        },
      );

      assert.notEqual(send.status, 0);
      assert.match(send.stderr, /channel_not_found/);
      assert.equal(completeCalls, 1);

      const activities = await activitiesForInboxItemWindow('scout', itemId);
      const failed = activities.at(-1);
      assert.equal(failed?.type, 'external.effect.failed');
      assert.equal(failed?.payload?.['effect'], 'slack.file.send');
      assert.equal(failed?.payload?.['tool'], 'anima.file.send');
      assert.match(String(failed?.payload?.['error'] ?? ''), /channel_not_found/);
      // basePayload fields (target, file list, caption-absent) still made it
      // into the failure activity so users can see what was attempted.
      assert.equal(failed?.payload?.['fileCount'], 1);
      assert.equal(failed?.payload?.['channelDisplayName'], '#product');
    });
  } finally {
    await slackApi.close();
    uploadServer.close();
    await once(uploadServer, 'close');
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('file send records audit without an active item', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-no-item-test-'));
  const uploadServer = createServer((request, response) => {
    void readHttpBody(request).then(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  uploadServer.listen(0, '127.0.0.1');
  await once(uploadServer, 'listening');
  const uploadAddr = uploadServer.address();
  if (!uploadAddr || typeof uploadAddr === 'string') throw new Error('upload server not bound');

  let uploadCount = 0;
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'files.getUploadURLExternal') {
      uploadCount += 1;
      return { ok: true, file_id: `F-no-item-${uploadCount}`, upload_url: `http://127.0.0.1:${uploadAddr.port}/upload/${uploadCount}` };
    }
    if (method === 'files.completeUploadExternal') {
      return { ok: true, files: [{ id: 'F-no-item-1', title: 'sent.png' }] };
    }
    if (method === 'files.info') {
      return { ok: true, file: { id: 'F-no-item-1', mimetype: 'image/png', name: 'sent.png', size: 1, ...sharedIn('C-product', '1770000700.000001') } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const localPath = join(stateDir, 'never.png');
      await writeFile(localPath, Buffer.from('x'));
      const send = await runNode(
        [cliPath, 'file', 'send', '--channel', 'C-product', localPath],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_INBOX_ITEM_ID: '',
            ANIMA_SLACK_API_URL: slackApi.url,
          },
        },
      );
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.equal(uploadCount, 1);
      const completed = allActivities(await loadState()).at(-1);
      assert.equal(completed?.type, 'external.effect.completed');
      assert.equal(completed?.payload?.['effect'], 'slack.file.send');
      assert.equal(Object.hasOwn(completed ?? {}, 'itemId'), false);
    });
  } finally {
    await slackApi.close();
    uploadServer.close();
    await once(uploadServer, 'close');
    await rm(stateDir, { force: true, recursive: true });
  }
});

// Slack sometimes never reports the share in time. This waits out the full
// bounded schedule twice (about 16 s); the schedule itself is unit-tested in
// slack-files.test.ts.
test('file send without a reported message ts still follows a reply thread, and warns on a top-level post', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-no-share-ts-test-'));
  const uploadServer = createServer((request, response) => {
    void readHttpBody(request).then(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  uploadServer.listen(0, '127.0.0.1');
  await once(uploadServer, 'listening');
  const uploadAddr = uploadServer.address();
  if (!uploadAddr || typeof uploadAddr === 'string') throw new Error('upload server not bound');

  let uploadCount = 0;
  let infoCount = 0;
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'conversations.info') {
      return {
        channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' },
        ok: true,
      };
    }
    if (method === 'files.getUploadURLExternal') {
      uploadCount += 1;
      return { ok: true, file_id: `F-slow-${uploadCount}`, upload_url: `http://127.0.0.1:${uploadAddr.port}/upload/${uploadCount}` };
    }
    if (method === 'files.completeUploadExternal') {
      return { ok: true, files: [{ id: `F-slow-${uploadCount}` }] };
    }
    if (method === 'files.info') {
      infoCount += 1;
      return { ok: true, file: { id: `F-slow-${uploadCount}`, mimetype: 'video/mp4', size: 1 } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const localPath = join(stateDir, 'clip.mp4');
      await writeFile(localPath, Buffer.from('x'));
      const send = (extra: string[]) => runNode(
        [cliPath, 'file', 'send', '--channel', 'C-product', ...extra, localPath],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_INBOX_ITEM_ID: '',
            ANIMA_SLACK_API_URL: slackApi.url,
          },
        },
      );

      // A reply needs only its thread to follow it.
      const reply = await send(['--thread-ts', '1770000800.000001']);
      assert.equal(reply.status, 0, reply.stderr || reply.stdout);
      assert.equal(reply.stdout.trim(), 'uploaded successfully. channel=#product, thread_ts=1770000800.000001, files=1.');
      assert.ok(infoCount > 1, 'waited before giving up on the share ts');
      let completed = allActivities(await loadState()).at(-1);
      assert.equal(completed?.payload?.['ts'], undefined);
      assert.equal(
        (completed?.payload?.['threadSubscription'] as Record<string, unknown> | undefined)?.['threadTs'],
        '1770000800.000001',
      );
      assert.equal(completed?.payload?.['warnings'], undefined);

      // A top-level post cannot follow its own thread without its ts; say so.
      const topLevel = await send([]);
      assert.equal(topLevel.status, 0, topLevel.stderr || topLevel.stdout);
      assert.equal(
        topLevel.stdout.trim(),
        'uploaded successfully. channel=#product, files=1. Note: Slack did not report the file message ts in time, so replies in its thread reach you only if they mention you.',
      );
      completed = allActivities(await loadState()).at(-1);
      assert.equal(completed?.payload?.['status'], 'sent');
      assert.equal(completed?.payload?.['threadSubscription'], undefined);
      assert.equal((completed?.payload?.['warnings'] as string[] | undefined)?.length, 1);
      const threads = Object.values((await loadState()).subscriptions).filter((subscription) => subscription.kind === 'thread');
      assert.deepEqual(threads.map((subscription) => subscription.threadTs), ['1770000800.000001']);
    });
  } finally {
    await slackApi.close();
    uploadServer.close();
    await once(uploadServer, 'close');
    await rm(stateDir, { force: true, recursive: true });
  }
});

// A files.info read after the upload must not hold the result hostage: the
// files have posted. Slack already reported the share ts at completion here,
// and the per-file read hangs until its 5 s request timeout cancels it (the
// 10 s deadline over all reads is unit-tested in slack-files.test.ts).
test('file send succeeds without retrying when files.info hangs after upload', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-hung-info-test-'));
  const counts = { complete: 0, info: 0, infoClosed: 0, upload: 0 };
  const server = createServer((request, response) => {
    void readHttpBody(request).then(() => {
      const method = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\/api\//, '');
      const reply = (body: object) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (method === 'files.info') {
        counts.info += 1;
        response.on('close', () => { counts.infoClosed += 1; });
        return;
      }
      if (method === '/upload') {
        counts.upload += 1;
        return reply({ ok: true });
      }
      if (method === 'conversations.info') {
        return reply({ channel: { id: 'C-product', is_channel: true, name: 'product', name_normalized: 'product' }, ok: true });
      }
      if (method === 'files.getUploadURLExternal') {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('server not bound');
        return reply({ ok: true, file_id: 'F-hung-1', upload_url: `http://127.0.0.1:${address.port}/upload` });
      }
      if (method === 'files.completeUploadExternal') {
        counts.complete += 1;
        return reply({ ok: true, files: [{ id: 'F-hung-1', ...sharedIn('C-product', '1770000900.000001') }] });
      }
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `unexpected method ${method}`, ok: false }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server not bound');
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const localPath = join(stateDir, 'chart.png');
      await writeFile(localPath, Buffer.from('x'));
      const started = Date.now();
      const send = await runNode(
        [cliPath, 'file', 'send', '--channel', 'C-product', localPath],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_INBOX_ITEM_ID: '',
            ANIMA_SLACK_API_URL: `http://127.0.0.1:${address.port}/api/`,
          },
        },
      );
      const elapsedMs = Date.now() - started;
      assert.equal(send.status, 0, send.stderr || send.stdout);
      assert.equal(send.stdout.trim(), 'uploaded successfully. channel=#product, message_ts=1770000900.000001, files=1.');
      assert.doesNotMatch(send.stderr, /WebClient/, 'the expected read timeout is not reported as a failure');
      assert.ok(elapsedMs < 12_000, `bounded by the read timeout and deadline, took ${elapsedMs} ms`);
      // Posted once, read once: no retry of the post or of the hung read, and
      // the read was cancelled rather than left running.
      assert.deepEqual(counts, { complete: 1, info: 1, infoClosed: 1, upload: 1 });

      const completed = allActivities(await loadState()).at(-1);
      assert.equal(completed?.payload?.['status'], 'sent');
      assert.equal(completed?.payload?.['ts'], '1770000900.000001');
      assert.equal(
        (completed?.payload?.['threadSubscription'] as Record<string, unknown> | undefined)?.['threadTs'],
        '1770000900.000001',
      );
    });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('file fetch supports --file-id/--output and positional output aliases', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-fetch-alias-test-'));
  const downloadServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('downloaded file bytes');
  });
  downloadServer.listen(0, '127.0.0.1');
  await once(downloadServer, 'listening');
  const downloadAddr = downloadServer.address();
  if (!downloadAddr || typeof downloadAddr === 'string') throw new Error('download server not bound');
  let infoCalls = 0;
  const slackApi = await startSlackApiMock((method) => {
    if (method === 'auth.test') return { ok: true, team_id: 'T-demo' };
    if (method === 'files.info') {
      infoCalls += 1;
      return {
        ok: true,
        file: {
          id: 'F-fetch',
          mimetype: 'text/plain',
          name: 'notes.txt',
          size: 21,
          url_private: `http://127.0.0.1:${downloadAddr.port}/notes.txt`,
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const env = {
        ...process.env,
        ANIMA_AGENT_ID: 'scout',
        ANIMA_HOME: stateDir,
        ANIMA_SLACK_API_URL: slackApi.url,
      };
      const output = join(stateDir, 'exports', 'notes.txt');
      const fetchByOption = await runNode(
        [cliPath, 'file', 'fetch', '--file-id', 'F-fetch', '--output', output],
        { env },
      );
      assert.equal(fetchByOption.status, 0, fetchByOption.stderr || fetchByOption.stdout);
      assert.equal(fetchByOption.stdout.trim(), output);
      assert.equal(await readFile(output, 'utf8'), 'downloaded file bytes');

      const positionalOutput = join(stateDir, 'exports', 'copy.txt');
      const fetchByPosition = await runNode(
        [cliPath, 'file', 'fetch', 'F-fetch', positionalOutput],
        { env },
      );
      assert.equal(fetchByPosition.status, 0, fetchByPosition.stderr || fetchByPosition.stdout);
      assert.equal(fetchByPosition.stdout.trim(), positionalOutput);
      assert.equal(await readFile(positionalOutput, 'utf8'), 'downloaded file bytes');
      assert.equal(infoCalls, 1);
    });
  } finally {
    await slackApi.close();
    downloadServer.close();
    await once(downloadServer, 'close');
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('file commands reject agent and item flags', async () => {
  const fetch = await runNode([cliPath, 'file', '--agent', 'scout', 'fetch', 'F-test']);
  assert.notEqual(fetch.status, 0);
  assert.match(fetch.stderr, /^error input\.invalid_options \(not retryable\): /);

  const send = await runNode([cliPath, 'file', '--item', 'turn_123', 'send', '--channel', 'C-product', 'missing.png']);
  assert.notEqual(send.status, 0);
  assert.match(send.stderr, /^error input\.invalid_options \(not retryable\): /);
});

for (const command of ['file send', 'message send --file']) test(`${command} rejects missing local path before any Slack call`, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-missing-path-test-'));
  let upstreamCalls = 0;
  const slackApi = await startSlackApiMock(() => {
    upstreamCalls += 1;
    return { ok: true };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackAgentConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const send = await runNode(
        command === 'file send'
          ? [cliPath, 'file', 'send', '--channel', 'C-product', join(stateDir, 'does-not-exist.png')]
          : [cliPath, 'message', 'send', '--channel', 'C-product', '--file', join(stateDir, 'does-not-exist.png')],
        {
          env: {
            ...process.env,
            ANIMA_AGENT_ID: 'scout',
            ANIMA_HOME: stateDir,
            ANIMA_INBOX_ITEM_ID: itemId,
            ANIMA_SLACK_API_URL: slackApi.url,
          },
        },
      );
      assert.notEqual(send.status, 0);
      assert.match(send.stderr, /file not found/);
      assert.equal(upstreamCalls, 0);
    });
  } finally {
    await slackApi.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function ingestSlackThread(stateDir: string): Promise<string> {
  return withAnimaHome(stateDir, async () => {
    const ctx = await ingestEvent(exampleSlackThread(), { agentId: 'scout', stateDir });
    return ctx.item.id;
  });
}

function exampleSlackThread() {
  return makeSlackEvent({
    channelId: 'C-product',
    channelName: 'product',
    eventId: 'evt_example_slack_thread',
    teamId: 'T-demo',
    text: 'Can you turn this discussion into a tracked product spike?',
    timestamp: '2026-05-11T00:00:00.000Z',
    threadTs: '1770000200.000001',
    ts: '1770000200.000002',
    userId: 'U-alice',
  });
}

// Slack's share stamp for the message an upload posted in a channel, as
// files.info and files.completeUploadExternal report it.
function sharedIn(channelId: string, ts: string, threadTs?: string) {
  return { shares: { public: { [channelId]: [{ ts, ...(threadTs ? { thread_ts: threadTs } : {}) }] } } };
}

function captionBlocks(complete: Record<string, unknown>): Array<{ type: string; text: string }> {
  const value = complete['blocks'];
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  assert.ok(Array.isArray(parsed), 'completeUploadExternal carries caption blocks');
  return parsed as Array<{ type: string; text: string }>;
}

function parseFilesField(value: unknown): Array<{ id: string; title?: string }> {
  if (typeof value !== 'string') return Array.isArray(value) ? value : [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
