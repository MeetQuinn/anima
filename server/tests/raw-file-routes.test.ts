import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type ReadStream } from 'node:fs';
import fs, { type FileHandle, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { defaultKbRegistryService } from '../kb/kb.service.js';
import { defaultDashboardAuthService } from '../settings/dashboard-auth.service.js';
import { createWebServer } from '../web/app.js';
import { withAnimaHome } from './anima-home.js';
import { defaultAgentConfig, waitFor, writeAgentConfigs } from './helpers/harness.js';

const routes = [
  (name: string) => `/kb/raw/test/${name}`,
  (name: string) => `/api/kbs/test/download?path=${name}`,
  (name: string) => `/api/agents/anima/home/raw/${name}`,
];

async function fixture(body: (base: string, files: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anima-raw-stream-')));
  const home = join(root, 'state');
  const files = join(root, 'files');
  await mkdir(files);
  await writeAgentConfigs(home, [{ ...defaultAgentConfig('anima'), homePath: files }]);
  await mkdir(join(home, 'kbs', 'test'), { recursive: true });
  await writeFile(join(home, 'kbs', 'test', 'config.json'), JSON.stringify({ label: 'Test', path: files }));
  try {
    await withAnimaHome(home, async () => {
      defaultKbRegistryService.clearCaches();
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        await body(`http://127.0.0.1:${address.port}`, files);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        defaultKbRegistryService.clearCaches();
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [index, route] of routes.entries()) {
  test(`raw file route ${index} serves exact byte ranges and HEAD metadata`, async () => fixture(async (base, files) => {
    const content = '0123456789abcdefghijklmnopqrstuvwxyz';
    await writeFile(join(files, 'sample.txt'), content);
    await writeFile(join(files, 'empty.txt'), '');
    const cases: Array<[string | undefined, number, string, string | undefined]> = [
      [undefined, 200, content, undefined],
      ['bytes=0-0', 206, '0', 'bytes 0-0/36'],
      ['bytes=4-9', 206, '456789', 'bytes 4-9/36'],
      ['bytes=32-', 206, 'wxyz', 'bytes 32-35/36'],
      ['bytes=-4', 206, 'wxyz', 'bytes 32-35/36'],
      ['bytes=-9999999999999999999999', 206, content, 'bytes 0-35/36'],
      ['bytes=32-9999999999999999999999', 206, 'wxyz', 'bytes 32-35/36'],
      ['bytes=36-', 416, '', 'bytes */36'],
      ['bytes=9999999999999999999999-', 416, '', 'bytes */36'],
      ['bytes=-0', 416, '', 'bytes */36'],
      ['bytes=9-4', 200, content, undefined],
      ['bytes=0-1,4-5', 200, content, undefined],
      ['items=0-1', 200, content, undefined],
      ['bytes=abc', 200, content, undefined],
    ];
    for (const [range, status, expected, contentRange] of cases) {
      const response = await fetch(base + route('sample.txt'), { headers: range ? { range } : {} });
      assert.equal(response.status, status, range);
      assert.equal(response.headers.get('content-range'), contentRange ?? null, range);
      assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(expected)), range);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/);
      assert.equal(await response.text(), expected, range);
    }
    const head = await fetch(base + route('sample.txt'), { method: 'HEAD', headers: { range: 'bytes=4-9' } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '36');
    assert.equal(head.headers.get('content-range'), null);
    assert.equal(await head.text(), '');
    for (const ifRange of ['"old-version"', '']) {
      const conditional = await fetch(base + route('sample.txt'), { headers: { range: 'bytes=4-9', 'if-range': ifRange } });
      assert.equal(conditional.status, 200);
      assert.equal(await conditional.text(), content);
    }
    const empty = await fetch(base + route('empty.txt'));
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('content-length'), '0');
    assert.equal(await empty.text(), '');
    const emptyRange = await fetch(base + route('empty.txt'), { headers: { range: 'bytes=0-' } });
    assert.equal(emptyRange.status, 416);
    assert.equal(emptyRange.headers.get('content-range'), 'bytes */0');
    await emptyRange.text();
    if (index === 1) assert.match(head.headers.get('content-disposition') ?? '', /^attachment;/);
    if (index === 2) assert.match(head.headers.get('content-disposition') ?? '', /^inline;/);
    assert.equal(head.headers.get('cache-control'), index === 2 ? 'private, max-age=60' : 'no-store');
  }));
}

test('concurrent file ranges use independent byte offsets even inside Unicode characters', async () => fixture(async (base, files) => {
  const content = Buffer.from('é好🙂'.repeat(1024));
  await writeFile(join(files, 'unicode.txt'), content);
  await Promise.all(routes.flatMap((route) => [0, 1, 3, 7].map(async (start) => {
    const response = await fetch(base + route('unicode.txt'), { headers: { range: `bytes=${start}-${start + 99}` } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${start + 99}/${content.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content.subarray(start, start + 100));
  })));
}));

test('raw file routes preserve authentication, containment and PDF headers with ranges', async () => fixture(async (base, files) => {
  await writeFile(join(files, 'report.pdf'), '%PDF-synthetic');
  const outside = join(files, '..', 'outside.txt');
  await writeFile(outside, 'outside');
  await symlink(outside, join(files, 'escape.txt'));
  for (const route of routes) {
    const escaped = await fetch(base + route('escape.txt'), { headers: { range: 'bytes=0-1' } });
    assert.ok(escaped.status === 400 || escaped.status === 404);
    assert.doesNotMatch(await escaped.text(), /outside/);
    const missing = await fetch(base + route('missing.txt'), { method: 'HEAD' });
    assert.equal(missing.status, 404);
    const pdf = await fetch(base + route('report.pdf'), { headers: { range: 'bytes=0-3' } });
    assert.equal(pdf.status, 206);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.doesNotMatch(pdf.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(await pdf.text(), '%PDF');
  }
  await defaultDashboardAuthService.setPassword('synthetic-password');
  for (const route of routes) {
    for (const method of ['HEAD', 'GET']) {
      const denied = await fetch(base + route('report.pdf'), { method, headers: { range: 'bytes=0-3' } });
      assert.equal(denied.status, 401);
      await denied.text();
    }
  }
}));

for (const [index, route] of routes.entries()) {
  test(`raw file route ${index} bounds reads and closes the file after client abort`, async () => fixture(async (base, files) => {
    const path = join(files, 'large.pdf');
    const file = await open(path, 'w');
    await file.truncate(64 * 1024 * 1024);
    await file.close();
    const streams: ReadStream[] = [];
    const handles: FileHandle[] = [];
    let fullReads = 0;
    let failOpen = false;
    let failRead = false;
    const originalOpen = fs.open;
    const originalRead = fs.readFile;
    fs.open = async (...args) => {
      if (String(args[0]) === path && failOpen) throw new Error('synthetic open failure');
      const handle = await originalOpen(...args);
      if (String(args[0]) === path) {
        handles.push(handle);
        const read = handle.readFile.bind(handle);
        handle.readFile = ((...readArgs: Parameters<typeof handle.readFile>) => {
          fullReads++;
          return read(...readArgs);
        }) as typeof handle.readFile;
        const create = handle.createReadStream.bind(handle);
        handle.createReadStream = (options) => {
          const stream = create(options);
          streams.push(stream);
          if (failRead) queueMicrotask(() => stream.destroy(new Error('synthetic read failure')));
          return stream;
        };
      }
      return handle;
    };
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === path) fullReads++;
      return originalRead(...args);
    }) as typeof fs.readFile;
    syncBuiltinESMExports();
    try {
      const head = await fetch(base + route('large.pdf'), { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(64 * 1024 * 1024));
      assert.equal(fullReads, 0, 'HEAD must not read the body');
      assert.equal(streams.length, 0, 'HEAD must not open a body stream');
      const partial = await fetch(base + route('large.pdf'), { headers: { range: 'bytes=100-1123' } });
      assert.equal(partial.status, 206);
      assert.equal((await partial.arrayBuffer()).byteLength, 1024);
      assert.equal(streams[0]?.bytesRead, 1024);
      const before = streams.length;
      const request = get(base + route('large.pdf'));
      const [response] = await once(request, 'response');
      response.pause();
      try {
        await delay(100);
        const stream = streams[before];
        assert.ok(stream);
        assert.ok(stream.bytesRead > 0 && stream.bytesRead < 16 * 1024 * 1024, `slow client read ${stream.bytesRead} bytes`);
        assert.equal(fullReads, 0, 'GET must not buffer the complete file');
      } finally {
        response.destroy();
        request.destroy();
      }
      await waitFor(async () => {
        const states = await Promise.all(handles.map((handle) => handle.stat().then(() => false, () => true)));
        return states.length === 3 && states.every(Boolean);
      });
      assert.equal(streams[before]?.destroyed, true);
      failRead = true;
      await assert.rejects(async () => {
        const response = await fetch(base + route('large.pdf'));
        await response.arrayBuffer();
      });
      await waitFor(async () => handles.length === 4 && await handles[3]!.stat().then(() => false, () => true));
      failOpen = true;
      const failed = await fetch(base + route('large.pdf'));
      assert.equal(failed.status, 500);
      assert.match(await failed.text(), /synthetic open failure/);
    } finally {
      fs.open = originalOpen;
      fs.readFile = originalRead;
      syncBuiltinESMExports();
    }
  }));
}
