import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { withAnimaHome } from './anima-home.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import {
  RuntimeUpgradeCheckStore,
  compareRuntimeVersions,
  runRuntimeUpgradeWorker,
  RuntimeUpgradeConflictError,
  RuntimeUpgradeService,
} from '../runtime/runtime-upgrade.js';

test('runtime version compare handles prerelease canaries', () => {
  assert.equal(compareRuntimeVersions('0.1.1-canary.5.1.723b529', '0.1.1-canary.4.1.0688e3f') > 0, true);
  assert.equal(compareRuntimeVersions('0.1.1-canary.4.2.aaaaaaa', '0.1.1-canary.4.1.zzzzzzz') > 0, true);
  assert.equal(compareRuntimeVersions('0.1.1', '0.1.1-canary.99.1.abcdef0') > 0, true);
  assert.equal(compareRuntimeVersions('0.1.1-canary.1', '0.1.1') < 0, true);
  assert.equal(compareRuntimeVersions('0.2.0', '0.1.9-canary.99') > 0, true);
});

test('runtime upgrade status is track-scoped and includes idle gate state', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-runtime-upgrade-status-'));
  try {
    await withAnimaHome(rootDir, async () => {
      await defaultServerSettingsService.setReleaseTrack('canary');
      const checkStore = new RuntimeUpgradeCheckStore();
      await checkStore.write({
        checkedAt: '2026-05-29T09:00:00.000Z',
        latestOnTrack: '0.1.1-canary.5.1.723b529',
        releaseTrack: 'canary',
      });
      const status = await new RuntimeUpgradeService({
        checkStore,
        distTagLookup: async ({ packageName, tag }) => {
          assert.equal(packageName, '@meetquinn/animactl');
          assert.equal(tag, 'canary');
          return '0.1.1-canary.5.1.723b529';
        },
        now: () => new Date('2026-05-29T09:10:00.000Z'),
        packageVersion: async () => '0.1.1-canary.4.1.0688e3f',
      }).status();

      assert.equal(status.currentVersion, '0.1.1-canary.4.1.0688e3f');
      assert.equal(status.releaseTrack, 'canary');
      assert.equal(status.latestOnTrack, '0.1.1-canary.5.1.723b529');
      assert.equal(status.state, 'available');
      assert.equal(status.updateAvailable, true);
      assert.equal(status.gate.state, 'idle');
      assert.deepEqual(status.gate.blockers, []);
      assert.equal(status.operation.status, 'idle');
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('runtime upgrade gate reports running blockers and ignores queued items', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-runtime-upgrade-running-gate-'));
  try {
    await withAnimaHome(rootDir, async () => {
      await writeAgentQueueFixture(rootDir, 'scout', [
        queueItem('item_queued', 'queued'),
        queueItem('item_running', 'running'),
      ]);
      const status = await new RuntimeUpgradeService({
        checkTtlMs: Number.MAX_SAFE_INTEGER,
        distTagLookup: async () => '0.1.2',
        packageVersion: async () => '0.1.1',
      }).status();

      assert.equal(status.gate.state, 'busy');
      assert.deepEqual(
        status.gate.blockers.map((blocker) => ({ itemId: blocker.itemId, status: blocker.status })),
        [{ itemId: 'item_running', status: 'running' }],
      );
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('runtime upgrade worker rolls metadata back when target artifact is incomplete before restart', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-runtime-upgrade-worker-'));
  const fakeNpm = join(rootDir, 'fake-npm.cjs');
  await writeFakeNpm(fakeNpm);
  const server = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/api/server-info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        animaHome: rootDir,
        dashboardPort: 4174,
        env: 'custom',
        ok: true,
        startedAt: '2026-05-29T08:18:33.000Z',
        uptimeSeconds: 10,
        version: '0.1.1',
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');

    await withAnimaHome(rootDir, async () => {
      await assert.rejects(
        () => runRuntimeUpgradeWorker({
          dashboardPort: address.port,
          npmCommand: fakeNpm,
          previousVersion: '0.1.1',
          releaseTrack: 'stable',
          targetVersion: '0.1.2',
          verifyTimeoutMs: 50,
        }),
        /Installed runtime template missing/,
      );

      const operation = JSON.parse(await readFile(join(rootDir, 'runtime', 'upgrade-status.json'), 'utf8')) as {
        rollback?: string;
        status?: string;
      };
      assert.equal(operation.status, 'failed');
      assert.equal(operation.rollback, 'succeeded');
      const installed = JSON.parse(await readFile(
        join(rootDir, 'runtime', 'current', 'node_modules', '@meetquinn', 'animactl', 'package.json'),
        'utf8',
      )) as { version?: string };
      assert.equal(installed.version, '0.1.1');
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(rootDir, { force: true, recursive: true });
  }
});

async function writeFakeNpm(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const prefix = args[args.indexOf('--prefix') + 1];
const spec = args[args.length - 1];
const version = spec.slice(spec.lastIndexOf('@') + 1);
const packageDir = join(prefix, 'node_modules', '@meetquinn', 'animactl');
mkdirSync(join(packageDir, 'dist', 'server', 'cli'), { recursive: true });
writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@meetquinn/animactl', version }, null, 2));
writeFileSync(join(packageDir, 'dist', 'server', 'cli', 'animactl.js'), 'process.exit(0);\\n');
if (version !== '0.1.2') {
  mkdirSync(join(packageDir, 'templates'), { recursive: true });
  writeFileSync(join(packageDir, 'templates', 'runtime-standing-prompt.md'), 'prompt');
}
`,
    'utf8',
  );
  await chmod(path, 0o755);
}

async function writeAgentQueueFixture(rootDir: string, agentId: string, items: Record<string, unknown>[]): Promise<void> {
  const agentDir = join(rootDir, 'agents', agentId);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'config.json'), `${JSON.stringify({ id: agentId }, null, 2)}\n`, 'utf8');
  await writeFile(
    join(agentDir, 'inbox.json'),
    `${JSON.stringify(Object.fromEntries(items.map((item) => [String(item['id']), item])), null, 2)}\n`,
    'utf8',
  );
}

function queueItem(id: string, status: 'queued' | 'running'): Record<string, unknown> {
  const createdAt = '2026-05-29T08:00:00.000Z';
  const handling: Record<string, unknown> = {
    createdAt,
    queuedAt: '2026-05-29T08:00:01.000Z',
    status,
    updatedAt: status === 'running' ? '2026-05-29T08:00:02.000Z' : '2026-05-29T08:00:01.000Z',
  };
  if (status === 'running') {
    handling['startedAt'] = '2026-05-29T08:00:02.000Z';
    handling['workerId'] = 'scout:12345';
  }
  return {
    channelId: 'D1',
    handling,
    id,
    kind: 'slack',
    messageTs: '1780040000.000001',
    receivedAt: createdAt,
    teamId: 'T1',
    text: id,
  };
}

test('runtime upgrade status degrades cleanly when npm check fails', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-runtime-upgrade-fail-'));
  try {
    await withAnimaHome(rootDir, async () => {
      const checkStore = new RuntimeUpgradeCheckStore();
      await checkStore.write({
        checkedAt: '2026-05-29T09:00:00.000Z',
        checkError: { message: 'Unable to check npm dist-tag: network unavailable', type: 'unknown' },
        releaseTrack: 'stable',
      });
      const status = await new RuntimeUpgradeService({
        checkStore,
        distTagLookup: async () => {
          throw new Error('network unavailable');
        },
        now: () => new Date('2026-05-29T09:10:00.000Z'),
        packageVersion: async () => '0.1.1',
      }).status();

      assert.equal(status.releaseTrack, 'stable');
      assert.equal(status.latestOnTrack, undefined);
      assert.equal(status.state, 'error');
      assert.equal(status.updateAvailable, false);
      assert.equal(status.checkError?.type, 'unknown');
      assert.match(status.checkError?.message ?? '', /network unavailable/);
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('runtime upgrade status returns cached state immediately and refreshes in background', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-runtime-upgrade-cache-'));
  try {
    await withAnimaHome(rootDir, async () => {
      const checkStore = new RuntimeUpgradeCheckStore();
      await checkStore.write({
        checkedAt: '2026-05-29T08:00:00.000Z',
        latestOnTrack: '0.1.2',
        releaseTrack: 'stable',
      });
      let lookupCalls = 0;
      const service = new RuntimeUpgradeService({
        checkStore,
        checkTtlMs: 0,
        distTagLookup: async () => {
          lookupCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return '0.1.3';
        },
        now: () => new Date('2026-05-29T09:00:00.000Z'),
        packageVersion: async () => '0.1.1',
      });

      const status = await service.status();
      assert.equal(status.latestOnTrack, '0.1.2');
      assert.equal(status.state, 'available');
      assert.equal(lookupCalls, 1);

      await waitFor(async () => (await checkStore.read()).latestOnTrack === '0.1.3');
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('runtime upgrade checkNow refreshes npm dist-tag before returning', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-runtime-upgrade-check-now-'));
  try {
    await withAnimaHome(rootDir, async () => {
      await defaultServerSettingsService.setReleaseTrack('canary');
      const checkStore = new RuntimeUpgradeCheckStore();
      await checkStore.write({
        checkedAt: '2026-05-29T08:00:00.000Z',
        latestOnTrack: '0.1.1-canary.21.1.cd63d38',
        releaseTrack: 'canary',
      });
      let lookupCalls = 0;
      const service = new RuntimeUpgradeService({
        checkStore,
        distTagLookup: async ({ packageName, tag }) => {
          lookupCalls += 1;
          assert.equal(packageName, '@meetquinn/animactl');
          assert.equal(tag, 'canary');
          return '0.1.1-canary.22.1.d153e32';
        },
        now: () => new Date('2026-05-29T09:00:00.000Z'),
        packageVersion: async () => '0.1.1-canary.21.1.cd63d38',
      });

      const status = await service.checkNow();

      assert.equal(lookupCalls, 1);
      assert.equal(status.checkedAt, '2026-05-29T09:00:00.000Z');
      assert.equal(status.latestOnTrack, '0.1.1-canary.22.1.d153e32');
      assert.equal(status.state, 'available');
      assert.equal(status.updateAvailable, true);
      assert.equal((await checkStore.read()).latestOnTrack, '0.1.1-canary.22.1.d153e32');
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('runtime upgrade apply records a scheduled operation and prevents duplicate scheduling', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-runtime-upgrade-apply-'));
  try {
    await withAnimaHome(rootDir, async () => {
      const service = new RuntimeUpgradeService({
        distTagLookup: async () => '0.1.2',
        packageVersion: async () => '0.1.1',
      });

      const prepared = await service.prepareApply({
        animactlScript: join(rootDir, 'dist', 'server', 'cli', 'animactl.js'),
        dashboardPort: 4175,
        previousStartedAt: '2026-05-29T08:18:33.000Z',
      });

      assert.equal(prepared.response.currentVersion, '0.1.1');
      assert.equal(prepared.response.latestOnTrack, '0.1.2');
      assert.equal(prepared.response.releaseTrack, 'stable');
      assert.equal(prepared.response.scheduled, true);

      await assert.rejects(
        () => service.prepareApply({ animactlScript: join(rootDir, 'dist', 'server', 'cli', 'animactl.js') }),
        RuntimeUpgradeConflictError,
      );
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition did not become true before timeout');
}
