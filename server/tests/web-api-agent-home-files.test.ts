import { once } from 'node:events';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { INLINE_TEXT_CAP } from '../kb/kb.helper.js';
import { AGENT_HOME_MANIFEST_ENTRY_CAP } from '../web/agent-home-file-routes.js';
import { createWebServer } from '../web/app.js';
import { withAnimaHome } from './anima-home.js';
import { defaultAgentConfig, writeAgentConfigs } from './helpers/harness.js';

type ManifestEntry = {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  ext?: string;
  size?: number;
};

type ManifestBody = {
  root: string;
  entries: ManifestEntry[];
  truncated: boolean;
};

async function withHomeServer<T>(
  homeDir: string,
  body: (base: string, stateDir: string) => Promise<T>,
): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-home-files-state-'));
  await writeAgentConfigs(stateDir, [{ ...defaultAgentConfig('anima'), homePath: homeDir }]);
  try {
    return await withAnimaHome(stateDir, async () => {
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP address');
        return await body(`http://127.0.0.1:${address.port}`, stateDir);
      } finally {
        server.close();
      }
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
}

async function getJson<T>(url: string): Promise<{ status: number; body: T; text: string }> {
  const response = await fetch(url);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as T, text };
}

async function writeHomeFile(homeDir: string, relPath: string, content: string | Buffer): Promise<void> {
  const absPath = join(homeDir, relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, content);
}

test('agent home files manifest includes nested files, dotfiles, directories, and sorted POSIX paths', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-home-files-home-'));
  try {
    await writeHomeFile(homeDir, 'MEMORY.md', '# Memory\n');
    await writeHomeFile(homeDir, 'notes/topic.md', 'topic\n');
    await writeHomeFile(homeDir, '.hidden', 'secret\n');
    await writeHomeFile(homeDir, 'scratch/tmp.txt', 'tmp\n');
    await mkdir(join(homeDir, 'empty'), { recursive: true });

    await withHomeServer(homeDir, async (base) => {
      const response = await getJson<ManifestBody>(`${base}/api/agents/anima/home/files`);
      assert.equal(response.status, 200);
      assert.equal(response.body.root, resolve(homeDir));
      assert.equal(response.body.truncated, false);
      assert.deepEqual(response.body.entries.map((entry) => entry.path), [
        '.hidden',
        'MEMORY.md',
        'empty',
        'notes',
        'notes/topic.md',
        'scratch',
        'scratch/tmp.txt',
      ]);
      assert.deepEqual(response.body.entries.find((entry) => entry.path === 'empty'), {
        path: 'empty',
        name: 'empty',
        kind: 'dir',
      });
      assert.equal(response.body.entries.find((entry) => entry.path === 'notes/topic.md')?.ext, 'md');
      assert.equal(response.body.entries.find((entry) => entry.path === 'scratch/tmp.txt')?.size, 4);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('agent home file read returns markdown content and metadata', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-home-files-home-'));
  try {
    const content = '# Memory\n';
    await writeHomeFile(homeDir, 'MEMORY.md', content);
    await withHomeServer(homeDir, async (base) => {
      const response = await getJson<Record<string, unknown>>(`${base}/api/agents/anima/home/files/MEMORY.md`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        path: 'MEMORY.md',
        name: 'MEMORY.md',
        kind: 'markdown',
        size: Buffer.byteLength(content),
        content,
      });
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('agent home file read classifies code files with language', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-home-files-home-'));
  try {
    await writeHomeFile(homeDir, 'notes/tool.ts', 'export const tool = true;\n');
    await withHomeServer(homeDir, async (base) => {
      const response = await getJson<Record<string, unknown>>(`${base}/api/agents/anima/home/files/notes/tool.ts`);
      assert.equal(response.status, 200);
      assert.equal(response.body.kind, 'code');
      assert.equal(response.body.language, 'typescript');
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('agent home file read marks oversized text truncated without content', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-home-files-home-'));
  try {
    await writeHomeFile(homeDir, 'large.txt', Buffer.alloc(INLINE_TEXT_CAP + 1, 'a'));
    await withHomeServer(homeDir, async (base) => {
      const response = await getJson<Record<string, unknown>>(`${base}/api/agents/anima/home/files/large.txt`);
      assert.equal(response.status, 200);
      assert.equal(response.body.kind, 'text');
      assert.equal(response.body.truncated, true);
      assert.equal('content' in response.body, false);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('agent home binary file is metadata-only and raw route returns exact bytes', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-home-files-home-'));
  try {
    const bytes = Buffer.from([0, 1, 2, 255]);
    await writeHomeFile(homeDir, 'data.bin', bytes);
    await withHomeServer(homeDir, async (base) => {
      const file = await getJson<Record<string, unknown>>(`${base}/api/agents/anima/home/files/data.bin`);
      assert.equal(file.status, 200);
      assert.equal(file.body.kind, 'binary');
      assert.equal('content' in file.body, false);

      const raw = await fetch(`${base}/api/agents/anima/home/raw/data.bin`);
      assert.equal(raw.status, 200);
      assert.equal(raw.headers.get('content-type'), 'application/octet-stream');
      assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

// fetch() cannot exercise the server-side traversal guard: the WHATWG URL parser
// normalizes dot segments (including the %2e-encoded forms) client-side, so the
// request never reaches the route. A real attacker sends the raw request line
// (curl --path-as-is, netcat), which find-my-way matches literally — so that is
// what this helper does.
async function rawGet(base: string, rawPath: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', rejectPromise);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const status = Number(raw.split(' ')[1] ?? '0');
      const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      resolvePromise({ status, body });
    });
  });
}

test('agent home file routes reject traversal and absolute path escapes without leaking content', async () => {
  const parentDir = await mkdtemp(join(tmpdir(), 'anima-home-files-parent-'));
  const homeDir = join(parentDir, 'home');
  const outsidePath = join(parentDir, 'outside.txt');
  try {
    await mkdir(homeDir);
    await writeFile(outsidePath, 'outside-canary');
    await withHomeServer(homeDir, async (base) => {
      // Raw request lines reach the wildcard route unnormalized; the lexical
      // guard must reject them itself.
      const rawTargets = [
        '/api/agents/anima/home/files/../outside.txt',
        '/api/agents/anima/home/files/%2e%2e/outside.txt',
        '/api/agents/anima/home/files/%2e%2e%2foutside.txt',
        `/api/agents/anima/home/raw/../outside.txt`,
      ];
      for (const target of rawTargets) {
        const response = await rawGet(base, target);
        assert.equal(response.status, 404, `expected 404 for ${target}`);
        assert.ok(response.body.includes('file_not_found'), `expected guard rejection for ${target}, got: ${response.body}`);
        assert.equal(response.body.includes('outside-canary'), false);
      }

      // An encoded absolute path survives fetch's normalization (single
      // segment), so it exercises the guard through the normal client too.
      const absolute = await getJson<{ error: string }>(
        `${base}/api/agents/anima/home/files/${encodeURIComponent(outsidePath)}`,
      );
      assert.equal(absolute.status, 404);
      assert.deepEqual(absolute.body, { error: 'file_not_found' });
      assert.equal(absolute.text.includes('outside-canary'), false);
    });
  } finally {
    await rm(parentDir, { force: true, recursive: true });
  }
});

test('agent home file routes reject symlink escapes and manifest does not traverse directory symlinks', async () => {
  const parentDir = await mkdtemp(join(tmpdir(), 'anima-home-files-parent-'));
  const homeDir = join(parentDir, 'home');
  const outsideDir = join(parentDir, 'outside-dir');
  try {
    await mkdir(homeDir);
    await mkdir(outsideDir);
    await writeFile(join(parentDir, 'outside.txt'), 'outside-canary');
    await writeFile(join(outsideDir, 'canary.txt'), 'dir-canary');
    await symlink(join(parentDir, 'outside.txt'), join(homeDir, 'outside-link.txt'));
    await symlink(outsideDir, join(homeDir, 'outside-dir-link'));

    await withHomeServer(homeDir, async (base) => {
      const file = await getJson<{ error: string }>(`${base}/api/agents/anima/home/files/outside-link.txt`);
      assert.equal(file.status, 404);
      assert.deepEqual(file.body, { error: 'file_not_found' });

      const raw = await getJson<{ error: string }>(`${base}/api/agents/anima/home/raw/outside-link.txt`);
      assert.equal(raw.status, 404);
      assert.deepEqual(raw.body, { error: 'file_not_found' });

      const manifest = await getJson<ManifestBody>(`${base}/api/agents/anima/home/files`);
      assert.equal(manifest.status, 200);
      assert.ok(manifest.body.entries.some((entry) => entry.path === 'outside-dir-link' && entry.kind === 'dir'));
      assert.equal(manifest.body.entries.some((entry) => entry.path === 'outside-dir-link/canary.txt'), false);
    });
  } finally {
    await rm(parentDir, { force: true, recursive: true });
  }
});

test('agent home file route returns not_a_file for directories', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-home-files-home-'));
  try {
    await mkdir(join(homeDir, 'notes'));
    await withHomeServer(homeDir, async (base) => {
      const response = await getJson<{ error: string }>(`${base}/api/agents/anima/home/files/notes`);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error: 'not_a_file' });
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('agent home files routes return not found for unknown agents', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-home-files-home-'));
  try {
    await withHomeServer(homeDir, async (base) => {
      const response = await getJson<{ error: string }>(`${base}/api/agents/missing/home/files`);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { error: 'Agent not found' });
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('agent home files manifest is empty when configured home directory is missing', async () => {
  const parentDir = await mkdtemp(join(tmpdir(), 'anima-home-files-parent-'));
  const homeDir = join(parentDir, 'missing-home');
  try {
    await withHomeServer(homeDir, async (base) => {
      await rm(homeDir, { force: true, recursive: true });
      const response = await getJson<ManifestBody>(`${base}/api/agents/anima/home/files`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { root: resolve(homeDir), entries: [], truncated: false });
    });
  } finally {
    await rm(parentDir, { force: true, recursive: true });
  }
});

test('agent home files manifest caps entries and reports truncation', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-home-files-home-'));
  try {
    await mkdir(join(homeDir, 'many'));
    await Promise.all(
      Array.from({ length: AGENT_HOME_MANIFEST_ENTRY_CAP + 1 }, (_value, index) =>
        writeFile(join(homeDir, 'many', `file-${String(index).padStart(4, '0')}.txt`), 'x'),
      ),
    );
    await withHomeServer(homeDir, async (base) => {
      const response = await getJson<ManifestBody>(`${base}/api/agents/anima/home/files`);
      assert.equal(response.status, 200);
      assert.equal(response.body.entries.length, AGENT_HOME_MANIFEST_ENTRY_CAP);
      assert.equal(response.body.truncated, true);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});
