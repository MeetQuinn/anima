import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// The runtime loads node:sqlite. It needs a flag before 22.13, and Node 23 could not load it before 23.4.
const cases: Array<[version: string, supported: boolean]> = [
  ['20.19.1', false],
  ['22.12.0', false],
  ['22.13.0', true],
  ['23.3.0', false],
  ['23.4.0', false],
  ['24.0.0', true],
  ['25.1.0', true],
];

test('the installer starts Anima only on Node 22.13+ or 24+', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-install-script-'));
  try {
    const bin = join(tempDir, 'bin');
    const npmCalls = join(tempDir, 'npm-calls');
    const preload = join(tempDir, 'fake-version.mjs');
    await writeFile(
      preload,
      "Object.defineProperty(process.versions, 'node', { value: process.env.FAKE_NODE_VERSION });\n",
    );
    await mkdir(bin);
    await writeFile(
      join(bin, 'node'),
      [
        '#!/bin/sh',
        'if [ "$1" = --version ]; then echo "v$FAKE_NODE_VERSION"; exit 0; fi',
        `exec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(preload)} "$@"`,
        '',
      ].join('\n'),
    );
    await writeFile(join(bin, 'npm'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(npmCalls)}\n`);
    await chmod(join(bin, 'node'), 0o755);
    await chmod(join(bin, 'npm'), 0o755);

    for (const [version, supported] of cases) {
      await rm(npmCalls, { force: true });
      const result = spawnSync('sh', [resolve('scripts/install.sh')], {
        encoding: 'utf8',
        env: { FAKE_NODE_VERSION: version, HOME: tempDir, PATH: `${bin}:/usr/bin:/bin` },
      });
      const npm = await readFile(npmCalls, 'utf8').catch(() => '');
      if (supported) {
        assert.equal(result.status, 0, `${version}: ${result.stderr}`);
        assert.match(npm, /^exec --yes --package @meetquinn\/animactl@latest -- animactl start$/m, version);
      } else {
        assert.equal(result.status, 1, `${version}: ${result.stdout}`);
        assert.match(result.stderr, new RegExp(`Node\\.js 22\\.13\\+ or 24\\+ is required; found v${version.replaceAll('.', '\\.')}\\.`));
        assert.equal(npm, '', version);
      }
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('the published package declares the same Node range as the installer', async () => {
  const manifest = JSON.parse(await readFile(resolve('packages/animactl/package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  assert.equal(manifest.engines?.node, '^22.13.0 || >=24');
});
