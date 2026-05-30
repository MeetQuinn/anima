import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { allActivities, loadState } from './helpers/state.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent } from './helpers/inbox.js';
import { withAnimaHome } from './anima-home.js';

const cliPath = resolve('dist/server/cli/anima.js');

test('file send uploads a local file and records an audited Slack output', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-send-test-'));
  const uploadUrls: string[] = [];
  const completeCalls: Array<Record<string, unknown>> = [];
  const uploadServerPosts: string[] = [];

  const uploadServer = createServer((request, response) => {
    void readBody(request).then((body) => {
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
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
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
      assert.match(send.stdout, /uploaded successfully\. channel=#product, files=1\./);

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
      return { ok: true, files: [{ id: 'F-batch-1' }, { id: 'F-batch-2' }] };
    }
    if (method === 'files.info') {
      return { ok: true, file: { id: 'F-batch-1', mimetype: 'image/png', size: 8, permalink: 'https://anima.slack.com/files/F-batch-1' } };
    }
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
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
      assert.match(send.stdout, /uploaded successfully\. channel=#product, thread_ts=1770000200\.000001, files=2\./);

      assert.equal(completeCalls.length, 1);
      const complete = completeCalls[0]!;
      assert.equal(complete['initial_comment'], 'see attached');
      assert.equal(complete['thread_ts'], '1770000200.000001');
      const files = parseFilesField(complete['files']);
      assert.equal(files.length, 2);

      const completed = (await activitiesForInboxItemWindow('scout', itemId)).at(-1);
      assert.equal(completed?.payload?.['fileCount'], 2);
      assert.equal(completed?.payload?.['caption'], 'see attached');
      assert.equal(completed?.payload?.['threadTs'], '1770000200.000001');
    });
  } finally {
    await slackApi.close();
    uploadServer.close();
    await once(uploadServer, 'close');
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
      return { ok: true, file: { id: 'F-stdin-1', mimetype: 'image/png', size: 4, permalink: 'https://anima.slack.com/files/F-stdin-1' } };
    }
    throw new Error(`unexpected method ${method}`);
  });

  // A caption that would be ruined by `bash -c "--caption \`anima file send\` ..."`:
  // backticks, $(), single + double quotes all live happily inside a heredoc.
  const captionWithShellMetachars = "uploaded via `anima file send` (cost: $(price) USD) — \"shipped\"";

  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
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
      assert.equal(complete['initial_comment'], captionWithShellMetachars);

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
      await writeSlackConfig(stateDir);
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
    void readBody(request).then(() => {
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
      return { ok: true, file: { id: 'F-no-item-1', mimetype: 'image/png', name: 'sent.png', size: 1 } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
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
      await writeSlackConfig(stateDir);
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
  assert.match(fetch.stderr, /unknown option '--agent'/);

  const send = await runNode([cliPath, 'file', '--item', 'turn_123', 'send', '--channel', 'C-product', 'missing.png']);
  assert.notEqual(send.status, 0);
  assert.match(send.stderr, /unknown option '--item'/);
});

test('file send rejects missing local path before any Slack call', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-file-missing-path-test-'));
  let upstreamCalls = 0;
  const slackApi = await startSlackApiMock(() => {
    upstreamCalls += 1;
    return { ok: true };
  });
  try {
    await withAnimaHome(stateDir, async () => {
      await writeSlackConfig(stateDir);
      const itemId = await ingestSlackThread(stateDir);

      const send = await runNode(
        [cliPath, 'file', 'send', '--channel', 'C-product', join(stateDir, 'does-not-exist.png')],
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

async function writeSlackConfig(
  configDir: string,
  slack: { appToken?: string; botToken?: string; teamId?: string } = {},
): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const agent = {
    id: 'scout',
    slack: {
      appToken: slack.appToken ?? 'xapp-test',
      botToken: slack.botToken ?? 'xoxb-test',
      teamId: slack.teamId ?? 'T-demo',
    },
  };
  const agentDir = join(configDir, 'agents', agent.id);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify({}, null, 2)}\n`, 'utf8');
  await writeFile(join(agentDir, 'config.json'), `${JSON.stringify(agent, null, 2)}\n`, 'utf8');
}

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

async function runNode(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(options.input);
  const [status] = (await once(child, 'exit')) as [number | null];
  return { status, stderr, stdout };
}

async function startSlackApiMock(
  handler: (method: string, body: string) => object,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const normalizedMethod = pathname.replace(/^\/api\//, '');
      const payload = handler(normalizedMethod, body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ok: false }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected Slack API mock to listen on a TCP address.');
  }
  return {
    close: async () => {
      server.close();
      await once(server, 'close');
    },
    url: `http://127.0.0.1:${address.port}/api`,
  };
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

function slackRequestBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  return body;
}
