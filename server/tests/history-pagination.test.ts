import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { activityServiceForAgent } from '../activities/activity.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { JsonlAppendLog } from '../storage/jsonl-log.js';
import { decodeHistoryCursor, encodeHistoryCursor, HistoryReadError } from '../storage/history-cursor.js';
import { renderCliError } from '../cli/cli-errors.js';
import { buildWebApp } from '../web/app.js';
import { withTempAnimaHome, writeAgentConfigs } from './helpers/harness.js';
import type { AgentMessageRecord } from '../../shared/messages.js';

const time = '2026-10-04T00:00:00.000Z';
function message(id: string, extra: Partial<AgentMessageRecord> = {}): AgentMessageRecord {
  return { messageId: id, direction: 'out', kind: 'message', platform: 'slack', source: { kind: 'activity', id },
    channelId: 'C-one', threadTs: 'root', text: 'find me', timestamp: time, ...extra };
}
async function seed(dir: string, rows: AgentMessageRecord[]): Promise<void> {
  const root = join(dir, 'agents/anima');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(join(root, 'activity.jsonl'), rows.map((r) => JSON.stringify({
    activityId: r.messageId, createdAt: r.timestamp, type: 'runtime.completed',
  })).join('\n') + '\n');
}

for (const scenario of ['ordered', 'same millisecond', 'late timestamp'] as const) {
  for (const feed of ['messages', 'activity'] as const) {
  test(`both feeds paginate every append occurrence: ${feed}, ${scenario}`, async () => {
    await withTempAnimaHome(async (dir) => {
      const rows = Array.from({ length: 30 }, (_, i) => message(String(i), {
        timestamp: scenario === 'same millisecond' ? time : new Date(Date.parse(time) + i * 1000).toISOString(),
      }));
      if (scenario === 'late timestamp') rows[10]!.timestamp = time;
      await seed(dir, rows);
        const actual: string[] = [];
        let before: string | undefined;
        for (let n = 0; n < 10; n++) {
          const page = feed === 'messages'
            ? await messageServiceForAgent('anima').list({ limit: 20, before })
            : await activityServiceForAgent('anima').listActivityFeed({ limit: 20, before });
          actual.push(...('entries' in page ? page.entries.map((r) => r.messageId)
            : [...page.events].reverse().map((r) => r.activityId)));
          before = page.nextCursor ?? undefined;
          if (!before) break;
        }
        assert.equal(before, undefined, 'pagination must reach EOF');
        assert.deepEqual(actual, rows.map((r) => r.messageId).reverse());
    });
  });
  }
}

test('duplicate logical ids use their append occurrence, including archive renames', async () => {
  await withTempAnimaHome(async (dir) => {
    await seed(dir, ['A', 'B', 'C', 'B', 'D', 'E', 'F'].map((id) => message(id)));
    const service = messageServiceForAgent('anima');
    const first = await service.list({ limit: 2 });
    assert.deepEqual(first.entries.map((r) => r.messageId), ['F', 'E']);
    const root = join(dir, 'agents/anima');
    await mkdir(join(root, 'messages.archive'));
    await rename(join(root, 'messages.jsonl'), join(root, 'messages.archive/000-old.jsonl'));
    await writeFile(join(root, 'messages.jsonl'), JSON.stringify(message('G')) + '\n');
    const second = await service.list({ before: first.nextCursor!, limit: 2 });
    const third = await service.list({ before: second.nextCursor!, limit: 3 });
    assert.deepEqual(second.entries.map((r) => r.messageId), ['D', 'B']);
    assert.deepEqual(third.entries.map((r) => r.messageId), ['C', 'B', 'A']);
    assert.equal(third.nextCursor, null);
  });
});

test('ISO to cursor retains time/channel/thread/direction scope over multiple pages', async () => {
  await withTempAnimaHome(async (dir) => {
    const rows = Array.from({ length: 10 }, (_, i) => message(String(i), {
      timestamp: new Date(Date.parse(time) + i * 1000).toISOString(),
    }));
    rows.splice(2, 0, message('wrong-channel', { channelId: 'C-two' }),
      message('wrong-thread', { threadTs: 'other' }), message('wrong-direction', { direction: 'in' }));
    await seed(dir, rows);
    const service = messageServiceForAgent('anima');
    const first = await service.list({ channel: 'C-one', threadTs: 'root', direction: 'out',
      since: time, before: '2026-10-04T00:00:08Z', limit: 3 });
    const second = await service.list({ before: first.nextCursor!, limit: 3 });
    const third = await service.list({ cursor: second.nextCursor!, limit: 5 });
    assert.deepEqual([...first.entries, ...second.entries, ...third.entries].map((r) => r.messageId),
      ['7', '6', '5', '4', '3', '2', '1', '0']);
    assert.equal(third.nextCursor, null);
    const f = decodeHistoryCursor(first.nextCursor!).f;
    assert.equal(f.beforeTime, '2026-10-04T00:00:08.000Z');
    const activity = activityServiceForAgent('anima');
    const a1 = await activity.listActivityFeed({ before: '2026-10-04T00:00:08Z', limit: 2 });
    const a2 = await activity.listActivityFeed({ before: a1.nextCursor!, limit: 2 });
    assert.deepEqual(a2.events.map((r) => r.activityId), ['4', '5']);
    assert.equal(decodeHistoryCursor(a2.nextCursor!).f.beforeTime, f.beforeTime);
    await assert.rejects(service.list({ before: first.nextCursor!, channel: 'C-two' }),
      { code: 'cursor_invalid', statusCode: 400 });
    await assert.rejects(service.list({ before: first.nextCursor!, threadTs: 'other' }),
      { code: 'cursor_invalid', statusCode: 400 });
    await assert.rejects(service.list({ cursor: first.nextCursor!, before: time }),
      { code: 'cursor_invalid', statusCode: 400 });
  });
});

test('search cursor retains normalized keywords and rejects changed search', async () => {
  await withTempAnimaHome(async (dir) => {
    await seed(dir, ['A', 'B', 'C', 'D'].map((id) => message(id)));
    const service = messageServiceForAgent('anima');
    const first = await service.search({ keywords: ['FIND', 'me'], limit: 2 });
    const second = await service.search({ before: first.nextCursor!, keywords: ['me', 'find', 'find'], limit: 2 });
    assert.deepEqual(second.entries.map((r) => r.messageId), ['B', 'A']);
    assert.equal(second.nextCursor, null);
    await assert.rejects(service.search({ before: first.nextCursor!, keywords: ['other'] }),
      { code: 'cursor_invalid', statusCode: 400 });
  });
});

test('cursor errors distinguish malformed, wrong scope, missing and ambiguous anchors', async () => {
  await withTempAnimaHome(async (dir) => {
    await seed(dir, ['A', 'B', 'C', 'B', 'D'].map((id) => message(id)));
    const service = messageServiceForAgent('anima');
    const first = await service.list({ limit: 2 }); // D, B
    const cursor = decodeHistoryCursor(first.nextCursor!);
    await assert.rejects(service.list({ before: 'c1.invalid' }), { code: 'cursor_invalid', statusCode: 400 });
    await assert.rejects(messageServiceForAgent('other').list({ before: first.nextCursor! }), { code: 'cursor_invalid' });
    await assert.rejects(activityServiceForAgent('anima').listActivityFeed({ before: first.nextCursor! }), { code: 'cursor_invalid' });
    const relocated = encodeHistoryCursor({ ...cursor, p: { ...cursor.p, ino: '0' } });
    await assert.rejects(service.list({ before: relocated }), /anchor_ambiguous/);
    const unique = await service.list({ limit: 1 }); // D, unique fallback succeeds
    const uniqueCursor = decodeHistoryCursor(unique.nextCursor!);
    const restored = await service.list({ before: encodeHistoryCursor({ ...uniqueCursor, p: { ...uniqueCursor.p, ino: '0' } }) });
    assert.deepEqual(restored.entries.map((r) => r.messageId), ['B', 'C', 'B', 'A']);
    await unlink(join(dir, 'agents/anima/messages.jsonl'));
    await assert.rejects(service.list({ before: first.nextCursor! }), { code: 'cursor_expired', statusCode: 410 });
    assert.match(renderCliError(new HistoryReadError('cursor_expired', 410, 'reload'))!, /anima.cursor_expired/);
    assert.match(renderCliError(new HistoryReadError('history_unstable', 503, 'retry'))!, /\(retryable\)/);
  });
});

for (const continuation of [false, true]) {
  test(`real append rotation during ${continuation ? 'continuation' : 'first'} page retries the whole scan`, async () => {
    await withTempAnimaHome(async (dir) => {
      const path = join(dir, 'log.jsonl');
      await writeFile(path, ['A', 'B', 'C', 'D'].map((id) => JSON.stringify({ id })).join('\n') + '\n');
      const log = new JsonlAppendLog<{ id: string }>(path, { archiveDir: join(dir, 'archive'), maxBytes: 1 });
      const input = { limit: 10, matches: () => true, idOf: (r: { id: string }) => r.id };
      const first = continuation ? await log.readPage({ ...input, limit: 1 }) : undefined;
      const anchor = first ? { p: first.rows[0]!.position, id: 'D' } : undefined;
      // Inject at the actual segment read boundary. append performs the real rename.
      const hooked = log as unknown as { readPageSegment: (s: unknown) => Promise<{ id: string }[]> };
      const original = hooked.readPageSegment.bind(log);
      let rotated = false;
      hooked.readPageSegment = async (s) => {
        const records = await original(s);
        if (!rotated) { rotated = true; await log.append({ id: 'E' }); }
        return records;
      };
      const page = await log.readPage({ ...input, anchor });
      assert.deepEqual(page.rows.map((r) => r.record.id), continuation ? ['C', 'B', 'A'] : ['E', 'D', 'C', 'B', 'A']);
      assert.equal(page.hasMore, false);
    });
  });
}

test('persistent real rotation returns 503 after bounded retries, never a false empty EOF', async () => {
  await withTempAnimaHome(async (dir) => {
    const path = join(dir, 'log.jsonl');
    await writeFile(path, '{"id":"A"}\n');
    const log = new JsonlAppendLog<{ id: string }>(path, { archiveDir: join(dir, 'archive'), maxBytes: 1 });
    const hooked = log as unknown as { readPageSegment: (s: unknown) => Promise<{ id: string }[]> };
    const original = hooked.readPageSegment.bind(log);
    let count = 0;
    hooked.readPageSegment = async (s) => {
      const records = await original(s);
      await log.append({ id: String(++count) });
      return records;
    };
    await assert.rejects(log.readPage({ limit: 10, matches: () => true, idOf: (r) => r.id }),
      { code: 'history_unstable', statusCode: 503 });
    assert.ok(count >= 3);
  });
});

test('real HTTP routes accept both cursor names and return cursor errors instead of empty history', async () => {
  await withTempAnimaHome(async (dir) => {
    await writeAgentConfigs(dir, [{ id: 'anima', provider: { kind: 'codex-cli', model: 'gpt-5.5', reasoningEffort: 'high', env: { CODEX_SECRET: '' } } }]);
    await seed(dir, ['A', 'B', 'C'].map((id) => message(id)));
    const app = buildWebApp();
    try {
      for (const feed of ['messages', 'activities']) {
        const url = `/api/agents/anima/${feed}`;
        const first = await app.inject({ url: `${url}?limit=1` });
        assert.equal(first.statusCode, 200, first.body);
        const cursor = first.json<{ nextCursor: string }>().nextCursor;
        const next = await app.inject({ url: `${url}?before=${encodeURIComponent(cursor)}` });
        assert.equal(next.statusCode, 200, next.body);
        const rows = next.json<{ entries?: AgentMessageRecord[]; events?: { activityId: string }[] }>();
        assert.deepEqual(rows.entries?.map((r) => r.messageId) ?? rows.events?.map((r) => r.activityId),
          feed === 'messages' ? ['B', 'A'] : ['A', 'B']);
        const alias = await app.inject({ url: `${url}?cursor=${encodeURIComponent(cursor)}` });
        assert.equal(alias.body, next.body);
        const invalid = await app.inject({ url: `${url}?before=c1.invalid` });
        assert.equal(invalid.statusCode, 400);
        assert.match(invalid.body, /cursor_invalid/);
        await unlink(join(dir, `agents/anima/${feed === 'messages' ? 'messages' : 'activity'}.jsonl`));
        const expired = await app.inject({ url: `${url}?before=${encodeURIComponent(cursor)}` });
        assert.equal(expired.statusCode, 410);
        assert.match(expired.body, /cursor_expired/);
      }
    } finally { await app.close(); }
  });
});
