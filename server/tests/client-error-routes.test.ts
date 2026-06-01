import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createWebServer } from '../web/app.js';
import { withAnimaHome } from './anima-home.js';

interface StoredClientError {
  kind: string;
  message: string;
  stack?: string;
  componentStack?: string;
  path: string;
  userAgent: string;
  createdAt: string;
  receivedAt: string;
}

// Spin up the real web server under a scoped ANIMA_HOME, run `body` against it,
// then tear it down. Mirrors the pattern in web-api.test.ts.
async function withServer(
  body: (base: string, home: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'anima-client-error-test-'));
  try {
    await withAnimaHome(home, async () => {
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected web API to listen on a TCP address.');
        }
        await body(`http://127.0.0.1:${address.port}`, home);
      } finally {
        server.close();
      }
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}

async function postClientError(base: string, body: string): Promise<Response> {
  return fetch(`${base}/api/client-errors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

async function readLog(home: string): Promise<StoredClientError[]> {
  const logPath = join(home, 'logs', 'client-errors.jsonl');
  let raw: string;
  try {
    raw = await readFile(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredClientError);
}

test('client-errors: valid payload returns 204 and writes JSONL under the active ANIMA_HOME', async () => {
  await withServer(async (base, home) => {
    const res = await postClientError(
      base,
      JSON.stringify({
        kind: 'error',
        message: 'Cannot read properties of undefined',
        stack: 'Error: x\n  at foo (app.js:1:1)',
        path: '/kb/team/skills.md',
        userAgent: 'probe/1.0',
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
    );
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');

    const records = await readLog(home);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record);
    assert.equal(record.kind, 'error');
    assert.equal(record.message, 'Cannot read properties of undefined');
    assert.equal(record.path, '/kb/team/skills.md');
    // The server stamps its own receipt time regardless of client input.
    assert.equal(typeof record.receivedAt, 'string');
    assert.ok(record.receivedAt.length > 0);
  });
});

test('client-errors: invalid payload (bad kind / missing message) returns 400 and writes nothing', async () => {
  await withServer(async (base, home) => {
    const badKind = await postClientError(
      base,
      JSON.stringify({
        kind: 'nope',
        message: 'x',
        path: '/',
        userAgent: 'p',
        createdAt: 'now',
      }),
    );
    assert.equal(badKind.status, 400);

    const missingMessage = await postClientError(
      base,
      JSON.stringify({ kind: 'error', path: '/', userAgent: 'p', createdAt: 'now' }),
    );
    assert.equal(missingMessage.status, 400);

    assert.equal((await readLog(home)).length, 0);
  });
});

test('client-errors: oversized body is rejected with 413 before parsing', async () => {
  await withServer(async (base, home) => {
    const res = await postClientError(
      base,
      JSON.stringify({
        kind: 'error',
        message: 'x'.repeat(40_000),
        path: '/',
        userAgent: 'p',
        createdAt: 'now',
      }),
    );
    assert.equal(res.status, 413);
    assert.equal((await readLog(home)).length, 0);
  });
});

test('client-errors: an over-long stack is truncated server-side', async () => {
  await withServer(async (base, home) => {
    const res = await postClientError(
      base,
      JSON.stringify({
        kind: 'error',
        message: 'long stack case',
        stack: 'S'.repeat(20_000),
        path: '/',
        userAgent: 'p',
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
    );
    assert.equal(res.status, 204);

    const records = await readLog(home);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record);
    assert.ok(record.stack);
    // 8_000 cap + the "…[truncated]" marker; far below the original 20_000.
    assert.ok(record.stack.length < 20_000);
    assert.ok(record.stack.endsWith('[truncated]'));
  });
});

test('client-errors: an absolute URL with userinfo/query/hash is reduced to its pathname only', async () => {
  await withServer(async (base, home) => {
    const res = await postClientError(
      base,
      JSON.stringify({
        kind: 'error',
        message: 'absolute url case',
        path: 'https://token@example.com/kb/foo?token=SECRET#frag',
        userAgent: 'p',
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
    );
    assert.equal(res.status, 204);

    const records = await readLog(home);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record);
    // Origin, userinfo, query, and hash must all be dropped — only the path remains.
    assert.equal(record.path, '/kb/foo');
  });
});

test('client-errors: a relative path keeps its pathname but drops query and hash', async () => {
  await withServer(async (base, home) => {
    const res = await postClientError(
      base,
      JSON.stringify({
        kind: 'render',
        message: 'relative path case',
        path: '/agents/nora?token=SECRET123#frag',
        userAgent: 'p',
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
    );
    assert.equal(res.status, 204);

    const records = await readLog(home);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record);
    assert.equal(record.path, '/agents/nora');
  });
});
