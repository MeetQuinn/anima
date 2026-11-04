import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { registerLinearCommands } from '../tools/linear-cli.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { serverConfigStore } from '../storage/schema/server.store.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { LinearReplyFilesService, prepareLinearReplyFiles } from '../linear/reply-files.service.js';
import { withTempAnimaHome } from './helpers/harness.js';
import { FakeLinear, created, install, seedLinear, sessionId } from './helpers/linear.js';
import { linearQueryErrors } from './helpers/linear-schema.js';

const issue = { id: randomUUID(), identifier: 'SYN-1', title: 'File reply', url: 'https://linear.app/synthetic/issue/SYN-1' };
const root = randomUUID();
const signed = 'https://storage.googleapis.com/private-upload?signature=UPLOAD_SECRET';
const listed = randomUUID();

class FilesWorkspace extends FakeLinear {
  uploads: Record<string, unknown>[] = [];
  puts: { bytes: string; headers: Headers }[] = [];
  comments: Record<string, any>[] = [];
  rejectPut = false;
  throwPut = false;
  asset = 'https://uploads.linear.app/private/file';
  afterPut?: () => Promise<void>;
  constructor() {
    super();
    const base = this.fetch;
    this.fetch = async (url, init) => {
      if (String(url) === signed) {
        assert.equal(init?.method, 'PUT'); assert.equal(init?.redirect, 'error');
        const headers = new Headers(init.headers);
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('x-upload-test'), 'SIGNED_HEADER_SECRET');
        this.puts.push({ bytes: await (init.body as Blob).text(), headers });
        await this.afterPut?.();
        if (this.throwPut) throw new Error(`${signed} ${install.accessToken} PRIVATE_STORAGE_BODY`);
        return new Response('PRIVATE_STORAGE_BODY', { status: this.rejectPut ? 403 : 200 });
      }
      const { query, variables } = JSON.parse(String(init?.body));
      assert.deepEqual(linearQueryErrors(query), []);
      if (query.includes('fileUpload(')) {
        this.uploads.push(variables);
        return Response.json({ data: { fileUpload: { success: true, uploadFile: {
          uploadUrl: signed, assetUrl: `${this.asset}/${this.uploads.length}`,
          headers: [{ key: 'x-upload-test', value: 'SIGNED_HEADER_SECRET' }],
        } } } });
      }
      if (query.includes('comment(id:')) return Response.json({ data: { comment: { issue, parent: { id: root } } } });
      if (query.includes('commentCreate(')) {
        this.comments.push(variables.input);
        return Response.json({ data: { commentCreate: { success: true, comment: { ...variables.input, issue, url: issue.url } } } });
      }
      if (query.includes('users(filter:')) return Response.json({ data: { users: { nodes: [{ id: listed, displayName: 'blocked', url: 'https://linear.app/synthetic/profiles/blocked' }] } } });
      return base(url, init);
    };
  }
}

async function fixture(t: TestContext, fn: (f: {
  home: string; fake: FilesWorkspace; output: string[]; stdin: (body: string) => void;
  run: (...args: string[]) => Promise<void>; seeded: Awaited<ReturnType<typeof seedLinear>>;
}) => Promise<void>) {
  await withTempAnimaHome(async (home) => {
    const fake = new FilesWorkspace(); const seeded = await seedLinear(home, fake);
    t.mock.method(globalThis, 'fetch', fake.fetch);
    const output: string[] = [];
    t.mock.method(console, 'log', (line: string) => output.push(line));
    t.mock.method(console, 'error', (line: string) => output.push(line));
    let body = '';
    t.mock.getter(process, 'stdin', () => Readable.from([body]) as typeof process.stdin);
    const run = async (...args: string[]) => {
      const cli = new Command(); registerLinearCommands(cli);
      await cli.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', ...args]);
    };
    await fn({ home, fake, output, stdin: (value) => { body = value; }, run, seeded });
  });
}

async function attachment(home: string, name = 'screenshot.png', body = 'synthetic PNG bytes') {
  const path = join(home, name); await writeFile(path, body); return path;
}

async function assertNoSecrets(output: string[]) {
  const rows = await activityServiceForAgent('scout').readAll();
  const outbox = await messageServiceForAgent('scout').list();
  assert.doesNotMatch(JSON.stringify([output, rows, outbox]), /UPLOAD_SECRET|SIGNED_HEADER_SECRET|PRIVATE_STORAGE_BODY|synthetic-access-sentinel/);
}

test('reply uploads multiple files then posts one threaded comment with a caption and audited private links', async (t) => fixture(t, async ({ home, fake, output, stdin, run }) => {
  const png = await attachment(home), log = await attachment(home, 'trace [1].log', 'trace bytes');
  stdin('**Evidence**');
  await run('reply', '--to', `comment:${randomUUID()}`, '--file', png, '--file', log);
  assert.deepEqual(fake.uploads.map((u) => [u.filename, u.contentType, u.size]), [['screenshot.png', 'image/png', 19], ['trace [1].log', 'text/plain', 11]]);
  assert.deepEqual(fake.puts.map((p) => p.bytes), ['synthetic PNG bytes', 'trace bytes']);
  assert.equal(fake.puts[0]!.headers.get('content-type'), 'image/png');
  assert.equal(fake.comments.length, 1); assert.equal(fake.comments[0]!.parentId, root);
  const body = '**Evidence**\n\n[screenshot.png](<https://uploads.linear.app/private/file/1>)\n\n[trace \\[1\\].log](<https://uploads.linear.app/private/file/2>)';
  assert.equal(fake.comments[0]!.body, body);
  const out = (await messageServiceForAgent('scout').list()).entries.filter((r) => r.direction === 'out');
  assert.equal(out.length, 1); assert.equal(out[0]!.text, body);
  const rows = await activityServiceForAgent('scout').readAll();
  assert.ok(rows.some((r) => r.payload?.effect === 'linear.file.upload' && r.payload.status === 'completed'));
  assert.ok(rows.some((r) => r.payload?.effect === 'linear.comment.create' && r.payload.text === body));
  await assertNoSecrets(output);
}));

test('file-only replies work, concurrent identical uploads reuse one private asset, changed bytes upload again', async (t) => fixture(t, async ({ home, fake, run, seeded }) => {
  const path = await attachment(home);
  const files = await prepareLinearReplyFiles([path]);
  const service = new LinearReplyFilesService(seeded.identity);
  const [a, b] = await Promise.all([service.upload(files), service.upload(files)]);
  assert.deepEqual(a, b); assert.equal(fake.puts.length, 1);
  assert.doesNotMatch(JSON.stringify(await seeded.store.read()), /UPLOAD_SECRET|SIGNED_HEADER_SECRET|storage.googleapis.com/);
  await run('reply', '--to', 'issue:SYN-1', '--file', path);
  assert.equal(fake.puts.length, 1);
  assert.equal(fake.comments[0]!.body, '[screenshot.png](<https://uploads.linear.app/private/file/1>)');
  await writeFile(path, 'changed');
  await run('reply', '--to', 'issue:SYN-1', '--file', path);
  assert.equal(fake.puts.length, 2);
}));

test('file session replies keep response and thought retry deduplication across new service instances', async (t) => fixture(t, async ({ home, fake, run, seeded, stdin }) => {
  const path = await attachment(home);
  await seeded.service.receive(created(), install);
  const [item] = await new WakeQueueService('scout').list(); await seeded.service.markStarted(item!, item!.id);
  stdin('Progress with evidence');
  await run('reply', '--to', `session:${sessionId}`, '--kind', 'thought', '--file', path);
  await run('reply', '--to', `session:${sessionId}`, '--kind', 'thought', '--file', path);
  assert.equal(fake.posts.length, 1);
  stdin('Done with evidence');
  await run('reply', '--to', `session:${sessionId}`, '--file', path);
  await run('reply', '--to', `session:${sessionId}`, '--file', path);
  assert.equal(fake.posts.length, 2); assert.equal(fake.puts.length, 1);
  assert.equal((await seeded.store.read()).receipts[item!.id]!.state, 'answered');
}));

test('all files and reply arguments are validated before upload', async (t) => fixture(t, async ({ home, fake, run }) => {
  const path = await attachment(home), empty = await attachment(home, 'empty.log', '');
  for (const invalid of [join(home, 'missing'), home, empty]) {
    await assert.rejects(run('reply', '--to', 'issue:SYN-1', '--file', path, '--file', invalid));
  }
  await assert.rejects(run('reply', '--to', 'issue:SYN-1', '--kind', 'thought', '--file', path), /Progress updates/);
  assert.equal(fake.uploads.length, 0); assert.equal(fake.comments.length, 0);
}));

test('contact checks cover filenames before upload and the complete generated body after upload', async (t) => fixture(t, async ({ home, fake, run }) => {
  await serverConfigStore.update((c) => ({ ...c, linearDoNotContact: { [install.organizationId]: [listed] } }));
  const named = await attachment(home, '@blocked evidence.log');
  await assert.rejects(run('reply', '--to', 'issue:SYN-1', '--file', named), /do-not-contact/);
  assert.equal(fake.uploads.length, 0);
  const path = await attachment(home);
  fake.asset = `https://uploads.linear.app/${listed}`;
  await assert.rejects(run('reply', '--to', 'issue:SYN-1', '--file', path), /do-not-contact/);
  assert.equal(fake.puts.length, 1); assert.equal(fake.comments.length, 0);
}));

test('storage HTTP/network failures post nothing and never disclose signed URLs, headers, tokens or server bodies', async (t) => fixture(t, async ({ home, fake, output, run }) => {
  const path = await attachment(home);
  fake.rejectPut = true;
  await assert.rejects(run('reply', '--to', 'issue:SYN-1', '--file', path), (error) => { output.push(String(error)); assert.match(String(error), /Linear file upload failed/); return true; });
  fake.rejectPut = false; fake.throwPut = true;
  await assert.rejects(run('reply', '--to', 'issue:SYN-1', '--file', path), (error) => { output.push(String(error)); assert.match(String(error), /Linear file upload failed/); return true; });
  assert.equal(fake.puts.length, 2); assert.equal(fake.comments.length, 0);
  await assertNoSecrets(output);
}));

test('identity revocation during upload blocks the reply and cache commit', async (t) => fixture(t, async ({ home, fake, run, seeded }) => {
  const path = await attachment(home);
  fake.afterPut = async () => { await seeded.agentStore.update((a) => ({ ...a, enabled: false })); };
  await assert.rejects(run('reply', '--to', 'issue:SYN-1', '--file', path), /disabled/);
  assert.equal(fake.comments.length, 0); assert.equal((await seeded.store.read()).installation?.uploadedFiles, undefined);
}));


test('a later upload failure leaves earlier files reusable and never posts a partial reply', async (t) => fixture(t, async ({ home, fake, run }) => {
  const first = await attachment(home), second = await attachment(home, 'trace.log', 'trace');
  fake.afterPut = async () => { fake.rejectPut = fake.puts.length === 2; };
  await assert.rejects(run('reply', '--to', 'issue:SYN-1', '--file', first, '--file', second), /upload failed/);
  assert.equal(fake.comments.length, 0);
  fake.afterPut = undefined; fake.rejectPut = false;
  await run('reply', '--to', 'issue:SYN-1', '--file', first, '--file', second);
  assert.equal(fake.puts.length, 3, 'only the failed file is uploaded again');
  assert.equal(fake.comments.length, 1);
  assert.match(fake.comments[0]!.body, /private\/file\/1/);
}));

test('temporary signed asset URLs are rejected before PUT and cannot enter output or audit', async (t) => fixture(t, async ({ home, fake, run, output }) => {
  const path = await attachment(home);
  fake.asset = 'https://uploads.linear.app/private?signature=UPLOAD_SECRET';
  await assert.rejects(run('reply', '--to', 'issue:SYN-1', '--file', path), (error) => { output.push(String(error)); assert.match(String(error), /invalid or rejected result/); return true; });
  assert.equal(fake.puts.length, 0); assert.equal(fake.comments.length, 0);
  await assertNoSecrets(output);
}));
