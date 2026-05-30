import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createWebServer } from '../web/app.js';
import { defaultKbRegistryService } from '../kb/kb.service.js';
import { withAnimaHome } from './anima-home.js';

interface KbFixture {
  homeDir: string;
  repoDir: string;
}

// Builds a temp ANIMA_HOME with a single kb root. The root `.gitignore`,
// when present, is the exposure boundary; otherwise visible files are read from
// disk. We add ordinary files, ignored files, a `.git/` metadata directory, and
// symlinks — covering every boundary branch.
async function setupKb(prefix: string): Promise<KbFixture> {
  const homeDir = await mkdtemp(join(tmpdir(), `${prefix}-home-`));
  const repoDir = await mkdtemp(join(tmpdir(), `${prefix}-repo-`));

  await mkdir(join(repoDir, 'docs'), { recursive: true });
  await writeFile(join(repoDir, 'README.md'), '# Title\n\nSome **markdown** body.\n', 'utf8');
  await writeFile(join(repoDir, 'docs', 'data.json'), '{"key":"value","n":1}\n', 'utf8');
  await writeFile(
    join(repoDir, 'docs', 'report.html'),
    '<!doctype html><html><body><h1>Report</h1><script>console.log("interactive")</script></body></html>\n',
    'utf8',
  );
  await writeFile(join(repoDir, 'docs', 'app.ts'), 'export const answer = 42;\n', 'utf8');
  await writeFile(join(repoDir, '.gitignore'), 'secret.txt\nignored/\n*.env\n!keep.env\n', 'utf8');
  // Ignored paths — must never surface.
  await writeFile(join(repoDir, 'secret.txt'), 'TOPSECRET-TOKEN\n', 'utf8');
  await mkdir(join(repoDir, 'ignored'), { recursive: true });
  await writeFile(join(repoDir, 'ignored', 'hidden.txt'), 'hidden\n', 'utf8');
  await writeFile(join(repoDir, 'fake.env'), 'FAKE_ENV_SECRET\n', 'utf8');
  await writeFile(join(repoDir, 'keep.env'), 'allowed by negation\n', 'utf8');
  // Untracked/uncommitted by git terms: present on disk and visible because it
  // is not ignored.
  await writeFile(join(repoDir, 'untracked.txt'), 'not added to git\n', 'utf8');
  await writeFile(join(repoDir, 'docs', 'untracked-target.md'), 'untracked target\n', 'utf8');
  await mkdir(join(repoDir, '.git'), { recursive: true });
  await writeFile(join(repoDir, '.git', 'config'), '[core]\n', 'utf8');
  // Symlink pointing at a visible file; allowed only because the resolved target
  // remains under the root and is itself visible.
  await symlink('README.md', join(repoDir, 'link.md'));
  await symlink('docs/untracked-target.md', join(repoDir, 'untracked-link.md'));
  await symlink('/etc/passwd', join(repoDir, 'escape-link.md'));

  await writeFile(
    join(homeDir, 'config.json'),
    `${JSON.stringify({}, null, 2)}\n`,
    'utf8',
  );
  await writeTestKbConfig(homeDir, { id: 'test', label: 'Test', path: repoDir });

  return { homeDir, repoDir };
}

async function writeTestKbConfig(
  homeDir: string,
  kb: { id: string; label: string; path: string },
): Promise<void> {
  const dir = join(homeDir, 'kbs', kb.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'config.json'),
    `${JSON.stringify({ label: kb.label, path: kb.path }, null, 2)}\n`,
    'utf8',
  );
}

async function withServer(
  homeDir: string,
  body: (base: string) => Promise<void>,
): Promise<void> {
  await withAnimaHome(homeDir, async () => {
    defaultKbRegistryService.clearCaches();
    const server = await createWebServer();
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      await body(`http://127.0.0.1:${address.port}`);
    } finally {
      server.close();
      defaultKbRegistryService.clearCaches();
    }
  });
}

test('kb roots endpoint lists configured roots without paths', async () => {
  const { homeDir, repoDir } = await setupKb('anima-kb-roots');
  try {
    await withServer(homeDir, async (base) => {
      const res = await fetch(`${base}/api/kbs`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { kbs: Array<{ id: string; label: string; path?: string }> };
      assert.deepEqual(body.kbs, [{ id: 'test', label: 'Test' }]);
      assert.equal(body.kbs[0] && 'path' in body.kbs[0], false, 'absolute path must not leak');
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(repoDir, { force: true, recursive: true });
  }
});

test('kb roots can be added and removed without restarting the web app', async () => {
  const { homeDir, repoDir } = await setupKb('anima-kb-mutate');
  const secondRepo = await mkdtemp(join(tmpdir(), 'anima-kb-mutate-second-'));
  try {
    await writeFile(join(secondRepo, 'SECOND.md'), '# Second\n', 'utf8');
    await mkdir(join(secondRepo, '.git'), { recursive: true });
    await writeFile(join(secondRepo, '.git', 'config'), '[core]\n', 'utf8');

    await withServer(homeDir, async (base) => {
      const add = await fetch(`${base}/api/kbs`, {
        body: JSON.stringify({ id: 'second', label: 'Second', path: secondRepo }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(add.status, 200);
      assert.deepEqual(await add.json(), {
        kbs: [
          { id: 'second', label: 'Second' },
          { id: 'test', label: 'Test' },
        ],
      });

      // The mutation clears the 5 s root cache, so the new root is browsable
      // immediately without a serve bounce.
      const tree = await fetch(`${base}/api/kbs/second/tree`);
      assert.equal(tree.status, 200);
      const treeBody = (await tree.json()) as { nodes: Array<{ name: string }> };
      assert.deepEqual(treeBody.nodes.map((node) => node.name), ['SECOND.md']);

      const duplicate = await fetch(`${base}/api/kbs`, {
        body: JSON.stringify({ id: 'second', label: 'Duplicate', path: secondRepo }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(duplicate.status, 409);

      const rename = await fetch(`${base}/api/kbs/second/rename`, {
        body: JSON.stringify({ label: 'Second Renamed' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(rename.status, 200);
      assert.deepEqual(await rename.json(), {
        kbs: [
          { id: 'second', label: 'Second Renamed' },
          { id: 'test', label: 'Test' },
        ],
      });

      const badRename = await fetch(`${base}/api/kbs/second/rename`, {
        body: JSON.stringify({ label: ' ' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(badRename.status, 400);

      const missing = await fetch(`${base}/api/kbs`, {
        body: JSON.stringify({ id: 'missing', label: 'Missing', path: join(secondRepo, 'missing') }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      assert.equal(missing.status, 400);

      const remove = await fetch(`${base}/api/kbs/second`, { method: 'DELETE' });
      assert.equal(remove.status, 200);
      assert.deepEqual(await remove.json(), { kbs: [{ id: 'test', label: 'Test' }] });

      const removedTree = await fetch(`${base}/api/kbs/second/tree`);
      assert.equal(removedTree.status, 404);

      const config = JSON.parse(await readFile(join(homeDir, 'kbs', 'test', 'config.json'), 'utf8')) as unknown;
      assert.deepEqual(config, { label: 'Test', path: repoDir });
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(repoDir, { force: true, recursive: true });
    await rm(secondRepo, { force: true, recursive: true });
  }
});

test('kb directory browser is home-bound and returns directories only', async () => {
  const { homeDir, repoDir } = await setupKb('anima-kb-browse');
  const browseRoot = await mkdtemp(join(homedir(), 'anima-kb-browse-'));
  try {
    await mkdir(join(browseRoot, 'visible-dir'));
    await mkdir(join(browseRoot, '.hidden-dir'));
    await writeFile(join(browseRoot, 'file.txt'), 'not a dir\n', 'utf8');

    await withServer(homeDir, async (base) => {
      const rootRes = await fetch(`${base}/api/filesystem/browse?path=${encodeURIComponent(browseRoot)}`);
      assert.equal(rootRes.status, 200);
      const body = (await rootRes.json()) as { path: string; entries: Array<{ name: string; path: string }> };
      assert.equal(body.path, browseRoot);
      assert.deepEqual(body.entries, [{ name: 'visible-dir', path: join(browseRoot, 'visible-dir') }]);

      const homeRes = await fetch(`${base}/api/filesystem/browse`);
      assert.equal(homeRes.status, 200, 'omitted path defaults to the server home directory');

      const outside = await fetch(`${base}/api/filesystem/browse?path=${encodeURIComponent(tmpdir())}`);
      assert.equal(outside.status, 400, 'directory browser cannot escape $HOME');
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(repoDir, { force: true, recursive: true });
    await rm(browseRoot, { force: true, recursive: true });
  }
});

test('kb tree exposes non-ignored files in a nested shape', async () => {
  const { homeDir, repoDir } = await setupKb('anima-kb-tree');
  try {
    await withServer(homeDir, async (base) => {
      const res = await fetch(`${base}/api/kbs/test/tree`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        kb: { id: string; label: string };
        nodes: Array<{ name: string; path: string; type: string; children?: unknown[] }>;
      };
      assert.equal(body.kb.id, 'test');
      const topNames = body.nodes.map((n) => n.name);
      assert.ok(topNames.includes('docs'), 'docs dir present');
      assert.ok(topNames.includes('README.md'), 'README present');
      assert.ok(topNames.includes('.gitignore'), '.gitignore is itself content');
      assert.ok(topNames.includes('untracked.txt'), 'untracked/uncommitted file present');
      assert.ok(topNames.includes('keep.env'), 'negated gitignore pattern is honored');
      assert.ok(!topNames.includes('secret.txt'), 'ignored secret absent');
      assert.ok(!topNames.includes('ignored'), 'ignored directory absent');
      assert.ok(!topNames.includes('fake.env'), 'glob-ignored env file absent');
      assert.ok(!topNames.includes('.git'), '.git metadata absent');

      const docs = body.nodes.find((n) => n.name === 'docs');
      assert.equal(docs?.type, 'dir');
      const docChildren = (docs?.children ?? []).map((c) => (c as { name: string }).name);
      assert.deepEqual([...docChildren].sort(), ['app.ts', 'data.json', 'report.html', 'untracked-target.md']);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(repoDir, { force: true, recursive: true });
  }
});

test('kb without root gitignore exposes all files except git metadata', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-kb-nogitignore-home-'));
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-kb-nogitignore-root-'));
  try {
    await writeFile(join(rootDir, 'notes.md'), '# Notes\n', 'utf8');
    await writeFile(join(rootDir, '.env'), 'VISIBLE_WITHOUT_GITIGNORE=1\n', 'utf8');
    await mkdir(join(rootDir, 'nested'), { recursive: true });
    await writeFile(join(rootDir, 'nested', 'data.txt'), 'nested\n', 'utf8');
    await mkdir(join(rootDir, '.git'), { recursive: true });
    await writeFile(join(rootDir, '.git', 'config'), '[core]\n', 'utf8');
    await writeFile(
      join(homeDir, 'config.json'),
      `${JSON.stringify({}, null, 2)}\n`,
      'utf8',
    );
    await writeTestKbConfig(homeDir, { id: 'plain', label: 'Plain', path: rootDir });

    await withServer(homeDir, async (base) => {
      const res = await fetch(`${base}/api/kbs/plain/tree`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        nodes: Array<{ name: string; children?: Array<{ name: string }> }>;
      };
      const topNames = body.nodes.map((node) => node.name);
      assert.ok(topNames.includes('notes.md'));
      assert.ok(topNames.includes('.env'), 'without .gitignore, dot/env files are content');
      assert.ok(topNames.includes('nested'));
      assert.ok(!topNames.includes('.git'), '.git metadata is never content');

      const envRes = await fetch(`${base}/api/kbs/plain/file?path=.env`);
      assert.equal(envRes.status, 200);
      assert.match(await envRes.text(), /VISIBLE_WITHOUT_GITIGNORE/);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('kb file endpoint classifies and inlines tracked text', async () => {
  const { homeDir, repoDir } = await setupKb('anima-kb-file');
  try {
    await withServer(homeDir, async (base) => {
      const md = await fetch(`${base}/api/kbs/test/file?path=README.md`);
      assert.equal(md.status, 200);
      const mdBody = (await md.json()) as { kind: string; content?: string; name: string };
      assert.equal(mdBody.kind, 'markdown');
      assert.equal(mdBody.name, 'README.md');
      assert.match(mdBody.content ?? '', /Some \*\*markdown\*\*/);

      const jsonRes = await fetch(`${base}/api/kbs/test/file?path=docs/data.json`);
      const jsonBody = (await jsonRes.json()) as { kind: string; content?: string };
      assert.equal(jsonBody.kind, 'json');
      assert.match(jsonBody.content ?? '', /"key":"value"/);

      const codeRes = await fetch(`${base}/api/kbs/test/file?path=docs/app.ts`);
      const codeBody = (await codeRes.json()) as { kind: string; language?: string };
      assert.equal(codeBody.kind, 'code');
      assert.equal(codeBody.language, 'typescript');

      // HTML is served via the raw route, so the file API does not inline bytes.
      const htmlRes = await fetch(`${base}/api/kbs/test/file?path=docs/report.html`);
      const htmlBody = (await htmlRes.json()) as { kind: string; content?: string };
      assert.equal(htmlBody.kind, 'html');
      assert.equal(htmlBody.content, undefined);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(repoDir, { force: true, recursive: true });
  }
});

test('kb download endpoint serves file with attachment headers', async () => {
  const { homeDir, repoDir } = await setupKb('anima-kb-discoverability');
  try {
    await withServer(homeDir, async (base) => {
      const download = await fetch(`${base}/api/kbs/test/download?path=${encodeURIComponent('README.md')}`);
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
      assert.match(download.headers.get('content-disposition') ?? '', /README\.md/);
      assert.match(await download.text(), /Some \*\*markdown\*\* body/);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(repoDir, { force: true, recursive: true });
  }
});


test('kb boundary refuses ignored, traversal, and unsafe symlink paths', async () => {
  const { homeDir, repoDir } = await setupKb('anima-kb-boundary');
  try {
    await withServer(homeDir, async (base) => {
      const untracked = await fetch(`${base}/api/kbs/test/file?path=untracked.txt`);
      assert.equal(untracked.status, 200, 'untracked/uncommitted file is visible when not ignored');

      const secret = await fetch(`${base}/api/kbs/test/file?path=secret.txt`);
      assert.equal(secret.status, 404, 'ignored secret never serves');

      const ignoredGlob = await fetch(`${base}/api/kbs/test/file?path=fake.env`);
      assert.equal(ignoredGlob.status, 404, 'glob-ignored env file never serves');

      const traversal = await fetch(
        `${base}/api/kbs/test/file?path=${encodeURIComponent('../../etc/passwd')}`,
      );
      assert.equal(traversal.status, 400, 'path traversal rejected pre-allowlist');

      const symlinkRes = await fetch(`${base}/api/kbs/test/file?path=link.md`);
      assert.equal(symlinkRes.status, 200, 'tracked same-root symlink to tracked target is allowed');
      const symlinkBody = await symlinkRes.json() as { content?: string };
      assert.match(symlinkBody.content ?? '', /Some \*\*markdown\*\* body/);

      const untrackedSymlink = await fetch(`${base}/api/kbs/test/file?path=untracked-link.md`);
      assert.equal(untrackedSymlink.status, 200, 'symlink target may be untracked when it is visible');

      const escapeSymlink = await fetch(`${base}/api/kbs/test/file?path=escape-link.md`);
      assert.equal(escapeSymlink.status, 404, 'symlink target must stay under the same root');

      const unknownRoot = await fetch(`${base}/api/kbs/nope/tree`);
      assert.equal(unknownRoot.status, 404, 'unknown kb root');
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(repoDir, { force: true, recursive: true });
  }
});

test('kb raw route serves tracked bytes with hardened headers', async () => {
  const { homeDir, repoDir } = await setupKb('anima-kb-raw');
  try {
    await withServer(homeDir, async (base) => {
      const res = await fetch(`${base}/kb/raw/test/docs/report.html`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /script-src/, 'CSP present');
      assert.doesNotMatch(csp, /script-src 'none'/, 'report scripts must run (sandboxed)');
      assert.match(csp, /object-src 'none'/);
      const html = await res.text();
      assert.match(html, /<script>console\.log/);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(repoDir, { force: true, recursive: true });
  }
});

test('malformed kbs config surfaces a visible error, not an empty surface', async () => {
  // milo review: a config validation failure must not silently degrade to
  // `200 {kbs:[]}` — that would hide the exact config boundary we want loud.
  const homeDir = await mkdtemp(join(tmpdir(), 'anima-kb-badconfig-home-'));
  try {
    await writeFile(
      join(homeDir, 'config.json'),
      `${JSON.stringify({}, null, 2)}\n`,
      'utf8',
    );
    await mkdir(join(homeDir, 'kbs', 'bad'), { recursive: true });
    await writeFile(
      join(homeDir, 'kbs', 'bad', 'config.json'),
      `${JSON.stringify({ label: '', path: '' }, null, 2)}\n`,
      'utf8',
    );
    await withServer(homeDir, async (base) => {
      const res = await fetch(`${base}/api/kbs`);
      assert.equal(res.status, 500, 'malformed config must surface, not empty out');
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? '', /label|path/);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test('kb raw route 404s on a miss instead of falling through to the SPA', async () => {
  const { homeDir, repoDir } = await setupKb('anima-kb-raw-miss');
  try {
    await withServer(homeDir, async (base) => {
      const miss = await fetch(`${base}/kb/raw/test/missing.txt`);
      assert.equal(miss.status, 404);
      assert.doesNotMatch(miss.headers.get('content-type') ?? '', /text\/html/);

      // Malformed (no <id>/<path> separator) is a bad request.
      const malformed = await fetch(`${base}/kb/raw/test`);
      assert.equal(malformed.status, 400);
    });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
    await rm(repoDir, { force: true, recursive: true });
  }
});
