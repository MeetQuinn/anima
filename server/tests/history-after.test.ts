import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { activityServiceForAgent } from '../activities/activity.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { JsonlAppendLog } from '../storage/jsonl-log.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../storage/history-cursor.js';
import { buildWebApp } from '../web/app.js';
import { withTempAnimaHome, writeAgentConfigs } from './helpers/harness.js';
import type { AgentMessageRecord } from '../../shared/messages.js';

// The live tail reads forward with `after`: the first page names the newest
// row (`headCursor`), and each `after` page names the last row it returned
// (`afterCursor`). Every check below compares what a forward reader collects
// with a full scan of the files on disk at the end, so a skipped, repeated or
// reordered row shows up as a diff, not as a count.

type Feed = 'messages' | 'activity';
const FEEDS: Feed[] = ['messages', 'activity'];
const time = '2026-10-05T00:00:00.000Z';

function message(id: string, extra: Partial<AgentMessageRecord> = {}): AgentMessageRecord {
  return { messageId: id, direction: 'out', kind: 'message', platform: 'slack', source: { kind: 'activity', id },
    channelId: 'C-one', threadTs: 'root', text: `row ${id}`, timestamp: time, ...extra };
}
function line(feed: Feed, id: string, extra: Partial<AgentMessageRecord> = {}): string {
  const row = message(id, extra);
  return JSON.stringify(feed === 'messages' ? row
    : { activityId: id, createdAt: row.timestamp, type: 'runtime.completed', payload: { text: row.text } });
}
const fileOf = (feed: Feed) => (feed === 'messages' ? 'messages' : 'activity');
const root = (dir: string) => join(dir, 'agents/anima');
const livePath = (dir: string, feed: Feed) => join(root(dir), `${fileOf(feed)}.jsonl`);
const archiveDir = (dir: string, feed: Feed) => join(root(dir), `${fileOf(feed)}.archive`);

async function seed(dir: string, feed: Feed, ids: string[]): Promise<void> {
  await mkdir(root(dir), { recursive: true });
  await writeFile(livePath(dir, feed), ids.map((id) => line(feed, id)).join('\n') + '\n');
}
async function append(dir: string, feed: Feed, ids: string[]): Promise<void> {
  if (ids.length) await appendFile(livePath(dir, feed), ids.map((id) => line(feed, id)).join('\n') + '\n');
}
let rotations = 0;
/** What rotateIfNeeded does: rename live into the archive dir under a sortable name. */
async function rotate(dir: string, feed: Feed): Promise<void> {
  await mkdir(archiveDir(dir, feed), { recursive: true });
  const stamp = String(Date.now() + rotations++).padStart(13, '0');
  await rename(livePath(dir, feed), join(archiveDir(dir, feed), `${stamp}-${fileOf(feed)}-000.jsonl`));
}
/** Full scan of every segment on disk, append order. */
async function fullScan(dir: string, feed: Feed): Promise<string[]> {
  const log = new JsonlAppendLog<{ messageId?: string; activityId?: string }>(livePath(dir, feed), {
    archiveDir: archiveDir(dir, feed), maxBytes: 10 * 1024 * 1024,
  });
  return (await log.readAll()).map((r) => r.messageId ?? r.activityId!);
}

interface Forward { ids: string[]; afterCursor: string | null; hasMore: boolean }
async function first(feed: Feed, limit = 100, filters: { channel?: string } = {}) {
  const page = feed === 'messages'
    ? await messageServiceForAgent('anima').list({ limit, ...filters })
    : await activityServiceForAgent('anima').listActivityFeed({ limit });
  return { headCursor: page.headCursor, ids: 'entries' in page ? page.entries.map((r) => r.messageId)
    : page.events.map((r) => r.activityId) };
}
async function after(feed: Feed, cursor: string, limit = 100, filters: { channel?: string } = {}): Promise<Forward> {
  const page = feed === 'messages'
    ? await messageServiceForAgent('anima').listAfter({ after: cursor, limit, ...filters })
    : await activityServiceForAgent('anima').listActivityFeedAfter({ after: cursor, limit });
  assert.equal(page.readAfter, true);
  return { ids: 'entries' in page ? page.entries.map((r) => r.messageId) : page.events.map((r) => r.activityId),
    afterCursor: page.afterCursor, hasMore: page.hasMore };
}

/** A forward reader: continue from each page's own last row until hasMore is false. */
async function drain(feed: Feed, anchor: string, limit: number, between?: (request: number) => Promise<void>) {
  const ids: string[] = [];
  let cursor = anchor;
  for (let request = 1; request <= 50; request += 1) {
    const page = await after(feed, cursor, limit);
    ids.push(...page.ids);
    if (page.afterCursor) cursor = page.afterCursor;
    if (!page.hasMore) return { ids, cursor, requests: request };
    await between?.(request);
  }
  throw new Error('forward read did not finish');
}
const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `${prefix}${from + i}`);

for (const feed of FEEDS) {
  test(`${feed}: headCursor names the newest row and after reads forward in append order`, async () => {
    await withTempAnimaHome(async (dir) => {
      await seed(dir, feed, range('s', 0, 30));
      const head = await first(feed, 10);
      assert.ok(head.headCursor);
      const decoded = decodeHistoryCursor(head.headCursor);
      assert.equal(decoded.id, 's29');
      assert.equal(decoded.p.line, 29);
      await append(dir, feed, range('n', 0, 25));
      const pages = [];
      let cursor = head.headCursor;
      for (;;) {
        const page = await after(feed, cursor, 10);
        pages.push(page);
        if (!page.hasMore) break;
        cursor = page.afterCursor!;
      }
      assert.deepEqual(pages.map((p) => p.ids.length), [10, 10, 5]);
      assert.deepEqual(pages.map((p) => p.hasMore), [true, true, false]);
      assert.deepEqual(pages.flatMap((p) => p.ids), range('n', 0, 25));
      // Each page ends where it says it ends.
      assert.deepEqual(pages.map((p) => decodeHistoryCursor(p.afterCursor!).id), ['n9', 'n19', 'n24']);
      // Idle: nothing after the last row. Empty page, no cursor to move to.
      assert.deepEqual(await after(feed, pages.at(-1)!.afterCursor!, 10), { ids: [], afterCursor: null, hasMore: false });
      // Older pages and after pages do not carry headCursor; only a first page names the head.
      assert.equal('headCursor' in (feed === 'messages'
        ? await messageServiceForAgent('anima').list({ before: head.headCursor, limit: 5 })
        : await activityServiceForAgent('anima').listActivityFeed({ before: head.headCursor, limit: 5 })), false);
    });
  });

  test(`${feed}: an empty log names no head and an exactly full page reports no more`, async () => {
    await withTempAnimaHome(async (dir) => {
      await seed(dir, feed, []);
      assert.equal((await first(feed)).headCursor, null);
      await append(dir, feed, ['a']);
      const head = await first(feed);
      await append(dir, feed, range('n', 0, 10));
      const exact = await after(feed, head.headCursor!, 10);
      assert.deepEqual(exact.ids, range('n', 0, 10));
      assert.equal(exact.hasMore, false);
      await append(dir, feed, ['n10']);
      assert.equal((await after(feed, head.headCursor!, 10)).hasMore, true);
    });
  });

  test(`${feed}: appends and rotations between continuations equal the final full scan`, async () => {
    await withTempAnimaHome(async (dir) => {
      await seed(dir, feed, range('s', 0, 40));
      const head = await first(feed);
      await append(dir, feed, range('a', 0, 150));
      const result = await drain(feed, head.headCursor!, 40, async (request) => {
        // 1: append; 2: rotate (the anchor row moves into the archive) then
        // append to a fresh live file; 3: rotate an all-new live file.
        if (request === 1) await append(dir, feed, range('b', 0, 30));
        if (request === 2) { await rotate(dir, feed); await seed(dir, feed, range('c', 0, 20)); }
        if (request === 3) { await rotate(dir, feed); await seed(dir, feed, range('d', 0, 5)); }
      });
      const all = await fullScan(dir, feed);
      assert.deepEqual(result.ids, all.slice(all.indexOf('s39') + 1));
      assert.equal(new Set(result.ids).size, result.ids.length);
      assert.equal(decodeHistoryCursor(result.cursor).id, 'd4');
    });
  });

  test(`${feed}: a rotation during a continuation retries the scan and still matches the full scan`, async () => {
    await withTempAnimaHome(async (dir) => {
      await seed(dir, feed, range('s', 0, 10));
      const head = await first(feed);
      await append(dir, feed, range('a', 0, 60));
      const page1 = await after(feed, head.headCursor!, 25);
      // Rotate inside the next read, after its first segment read: the scan must
      // notice and start over rather than return a page cut at the old file.
      const proto = JsonlAppendLog.prototype as unknown as { readPageSegment: (s: unknown) => Promise<unknown[]> };
      const original = proto.readPageSegment;
      let rotated = 0;
      proto.readPageSegment = async function (this: unknown, s: unknown) {
        const records = await original.call(this, s);
        if (rotated++ === 0) { await rotate(dir, feed); await seed(dir, feed, range('r', 0, 7)); }
        return records;
      };
      let rest: Awaited<ReturnType<typeof drain>>;
      try {
        rest = await drain(feed, page1.afterCursor!, 25);
      } finally {
        proto.readPageSegment = original;
      }
      assert.ok(rotated > 1, 'the hook ran and the scan retried');
      const all = await fullScan(dir, feed);
      assert.deepEqual([...page1.ids, ...rest.ids], all.slice(all.indexOf('s9') + 1));
      assert.ok(rest.ids.includes('r6'));
    });
  });

  test(`${feed}: duplicate ids are separate rows; position, not id, decides where a read resumes`, async () => {
    await withTempAnimaHome(async (dir) => {
      await seed(dir, feed, ['A', 'B', 'C']);
      const head = await first(feed);
      // A restore re-appends B and C (C is the anchor's own id), then D lands.
      await append(dir, feed, ['B', 'C', 'B', 'D']);
      const one = await drain(feed, head.headCursor!, 1);
      assert.deepEqual(one.ids, ['B', 'C', 'B', 'D']);
      assert.equal(one.requests, 4);
      assert.deepEqual((await after(feed, head.headCursor!, 10)).ids, ['B', 'C', 'B', 'D']);
      // Relocated anchor (restore/copy: new inode). A unique id is still safe...
      const d = decodeHistoryCursor(one.cursor);
      await append(dir, feed, ['E']);
      const relocated = (id: string, lineNo: number) => encodeHistoryCursor({ ...d, id, p: { ...d.p, ino: '0', line: lineNo } });
      assert.deepEqual((await after(feed, relocated('D', 6), 10)).ids, ['E']);
      assert.deepEqual((await after(feed, relocated('A', 0), 10)).ids, ['B', 'C', 'B', 'C', 'B', 'D', 'E']);
      // ...a duplicated one is not: refuse instead of guessing which copy.
      await assert.rejects(after(feed, relocated('C', 2), 10), { code: 'cursor_expired', statusCode: 410 });
    });
  });

  test(`${feed}: a lost anchor is 410, persistent rotation is 503, never a false empty page`, async () => {
    await withTempAnimaHome(async (dir) => {
      await seed(dir, feed, ['A', 'B']);
      const head = await first(feed);
      await append(dir, feed, ['C']);
      await unlink(livePath(dir, feed));
      await seed(dir, feed, ['X']);
      await assert.rejects(after(feed, head.headCursor!), { code: 'cursor_expired', statusCode: 410 });
      const fresh = await first(feed);
      await append(dir, feed, ['Y']);
      const proto = JsonlAppendLog.prototype as unknown as { readPageSegment: (s: unknown) => Promise<unknown[]> };
      const original = proto.readPageSegment;
      let reads = 0;
      proto.readPageSegment = async function (this: unknown, s: unknown) {
        const records = await original.call(this, s);
        reads += 1;
        await rotate(dir, feed);
        await seed(dir, feed, [`z${reads}`]);
        return records;
      };
      try {
        await assert.rejects(after(feed, fresh.headCursor!), { code: 'history_unstable', statusCode: 503 });
      } finally {
        proto.readPageSegment = original;
      }
      assert.ok(reads >= 3);
    });
  });
}

test('after inherits the cursor scope and refuses to be combined with another cursor or bound', async () => {
  await withTempAnimaHome(async (dir) => {
    await seed(dir, 'messages', ['A', 'B']);
    await appendFile(livePath(dir, 'messages'), JSON.stringify(message('other', { channelId: 'C-two' })) + '\n');
    const head = await first('messages', 10, { channel: 'C-one' });
    assert.equal(decodeHistoryCursor(head.headCursor!).id, 'B');
    assert.equal(decodeHistoryCursor(head.headCursor!).f.channel, 'C-one');
    await appendFile(livePath(dir, 'messages'), [message('C'), message('x', { channelId: 'C-two' }), message('D')]
      .map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.deepEqual((await after('messages', head.headCursor!, 10)).ids, ['C', 'D']);
    assert.deepEqual((await after('messages', head.headCursor!, 10, { channel: 'C-one' })).ids, ['C', 'D']);
    const service = messageServiceForAgent('anima');
    await assert.rejects(service.listAfter({ after: head.headCursor!, channel: 'C-two' }), { code: 'cursor_invalid', statusCode: 400 });
    await assert.rejects(service.listAfter({ after: head.headCursor!, before: head.headCursor! }), { code: 'cursor_invalid', statusCode: 400 });
    await assert.rejects(service.listAfter({ after: head.headCursor!, cursor: head.headCursor! }), { code: 'cursor_invalid', statusCode: 400 });
    await assert.rejects(service.listAfter({ after: time }), { code: 'cursor_invalid', statusCode: 400 });
    await assert.rejects(activityServiceForAgent('anima').listActivityFeedAfter({ after: head.headCursor! }),
      { code: 'cursor_invalid', statusCode: 400 });
  });
});

test('real HTTP routes: after pages are marked, idle is a constant empty body, errors keep their status', async () => {
  await withTempAnimaHome(async (dir) => {
    await writeAgentConfigs(dir, [{ id: 'anima', provider: { kind: 'codex-cli', model: 'gpt-5.5', reasoningEffort: 'high', env: { CODEX_SECRET: '' } } }]);
    for (const feed of FEEDS) await seed(dir, feed, range('s', 0, 120));
    const app = buildWebApp();
    try {
      for (const feed of FEEDS) {
        const url = `/api/agents/anima/${feed === 'messages' ? 'messages' : 'activities'}`;
        const firstPage = await app.inject({ url: `${url}?limit=100` });
        assert.equal(firstPage.statusCode, 200, firstPage.body);
        const headCursor = firstPage.json<{ headCursor: string }>().headCursor;
        const idle = await app.inject({ url: `${url}?limit=100&after=${encodeURIComponent(headCursor)}` });
        assert.equal(idle.statusCode, 200, idle.body);
        assert.equal(idle.body, feed === 'messages'
          ? '{"readAfter":true,"entries":[],"afterCursor":null,"hasMore":false}'
          : '{"readAfter":true,"events":[],"afterCursor":null,"hasMore":false}');
        await append(dir, feed, ['n0', 'n1']);
        const fresh = await app.inject({ url: `${url}?after=${encodeURIComponent(headCursor)}` });
        const body = fresh.json<{ readAfter: boolean; entries?: { messageId: string }[]; events?: { activityId: string }[]; hasMore: boolean }>();
        assert.equal(body.readAfter, true);
        assert.deepEqual(body.entries?.map((r) => r.messageId) ?? body.events?.map((r) => r.activityId), ['n0', 'n1']);
        assert.equal(body.hasMore, false);
        const conflict = await app.inject({ url: `${url}?after=${encodeURIComponent(headCursor)}&before=${encodeURIComponent(headCursor)}` });
        assert.equal(conflict.statusCode, 400);
        assert.match(conflict.body, /cursor_invalid/);
        await unlink(livePath(dir, feed));
        await seed(dir, feed, ['other']);
        const expired = await app.inject({ url: `${url}?after=${encodeURIComponent(headCursor)}` });
        assert.equal(expired.statusCode, 410);
        assert.match(expired.body, /^\{"error":"cursor_expired: /);
      }
    } finally { await app.close(); }
  });
});
