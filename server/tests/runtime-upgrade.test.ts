import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { withAnimaHome } from './anima-home.js';
import { sleep } from './helpers/harness.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import {
  RuntimeUpgradeCheckStore,
  RuntimeUpgradeOperationStore,
  compareRuntimeVersions,
  runRuntimeUpgradeWorker,
  RuntimeUpgradeConflictError,
  RuntimeUpgradeUnavailableError,
  RuntimeUpgradeService,
  runtimeUpgradeWorkerSpawnPlan,
} from '../runtime-management/runtime-upgrade.js';
import { serverConfigStore } from '../storage/schema/server.store.js';

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
      assert.equal(status.releaseNotesUrl, undefined);
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

test('runtime upgrade status clears failed operations superseded by the current version', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-runtime-upgrade-superseded-fail-'));
  try {
    await withAnimaHome(rootDir, async () => {
      await defaultServerSettingsService.setReleaseTrack('canary');
      const checkStore = new RuntimeUpgradeCheckStore();
      await checkStore.write({
        checkedAt: '2026-06-03T07:11:49.902Z',
        latestOnTrack: '0.1.4-canary.124.1.6ded17e',
        releaseTrack: 'canary',
      });
      const operationStore = new RuntimeUpgradeOperationStore();
      await operationStore.write({
        completedAt: '2026-06-03T06:58:03.887Z',
        currentVersion: '0.1.4-canary.108.1.e8cc04e',
        error: 'services restart exited with code 1',
        previousVersion: '0.1.4-canary.108.1.e8cc04e',
        rollback: 'succeeded',
        startedAt: '2026-06-03T06:57:58.598Z',
        status: 'failed',
        targetVersion: '0.1.4-canary.123.1.004dcde',
      });

      const status = await new RuntimeUpgradeService({
        checkStore,
        checkTtlMs: Number.MAX_SAFE_INTEGER,
        operationStore,
        packageVersion: async () => '0.1.4-canary.124.1.6ded17e',
      }).status();

      assert.equal(status.state, 'current');
      assert.equal(status.updateAvailable, false);
      assert.equal(status.operation.status, 'idle');
      assert.equal((await operationStore.read()).status, 'idle');
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('runtime upgrade status is unsupported on dev/source runtime and skips npm checks', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-runtime-upgrade-dev-status-'));
  try {
    await withAnimaHome(rootDir, async () => {
      await serverConfigStore.write({ track: 'dev' });
      const checkStore = new RuntimeUpgradeCheckStore();
      await checkStore.write({
        checkedAt: '2026-06-03T08:00:00.000Z',
        latestOnTrack: '0.1.3',
        releaseTrack: 'stable',
      });
      let lookupCalls = 0;
      const status = await new RuntimeUpgradeService({
        checkStore,
        checkTtlMs: 0,
        distTagLookup: async () => {
          lookupCalls += 1;
          return '0.1.4';
        },
        packageVersion: async () => '0.1.4-dev',
      }).status();

      assert.equal(status.state, 'unsupported');
      assert.equal(status.updateAvailable, false);
      assert.equal(status.latestOnTrack, undefined);
      assert.match(status.unsupportedReason ?? '', /dev\/source/);
      assert.equal(lookupCalls, 0);
    });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
});

test('runtime upgrade apply is unavailable on dev/source runtime', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'anima-runtime-upgrade-dev-apply-'));
  try {
    await withAnimaHome(rootDir, async () => {
      await serverConfigStore.write({ track: 'dev' });
      let lookupCalls = 0;
      const service = new RuntimeUpgradeService({
        distTagLookup: async () => {
          lookupCalls += 1;
          return '0.1.4';
        },
        packageVersion: async () => '0.1.4-dev',
      });

      await assert.rejects(
        () => service.prepareApply({ animactlScript: join(rootDir, 'dist', 'server', 'cli', 'animactl.js') }),
        RuntimeUpgradeUnavailableError,
      );
      assert.equal(lookupCalls, 0);
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
        ok: true,
        startedAt: '2026-05-29T08:18:33.000Z',
        track: 'stable',
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

test('runtime upgrade worker uses a transient systemd user unit on Linux', () => {
  const plan = runtimeUpgradeWorkerSpawnPlan({
    animactlScript: '/opt/anima/current/node_modules/@meetquinn/animactl/dist/server/cli/animactl.js',
    animaHome: '/home/ubuntu/.anima',
    dashboardHost: '127.0.0.1',
    dashboardPort: 4174,
    env: {
      ANIMA_AGENT_ID: 'milo',
      ANIMA_HOME: '/tmp/wrong-home',
      PATH: '/usr/bin:/bin',
      USER: 'ubuntu',
    },
    logPath: '/home/ubuntu/.anima/logs/runtime-upgrade.log',
    nodePath: '/usr/bin/node',
    nowMs: 1782711779000,
    platform: 'linux',
    previousStartedAt: '2026-06-29T05:00:00.000Z',
    previousVersion: '0.1.11-canary.308.1.57ab7e5',
    releaseTrack: 'canary',
    targetVersion: '0.1.11-canary.309.1.180614d',
  });

  assert.equal(plan.command, 'systemd-run');
  assert.equal(plan.detached, true);
  assert.equal(plan.stdio, 'ignore');
  assert.equal(plan.waitForExit, true);
  assert.equal(plan.cwd, '/opt/anima/current/node_modules/@meetquinn/animactl');
  assert.ok(plan.args.includes('--user'));
  assert.ok(plan.args.includes('--quiet'));
  assert.ok(plan.args.includes('--collect'));
  assert.ok(plan.args.some((arg) => /^--unit=anima-runtime-upgrade-\d+-1782711779000$/.test(arg)));
  assert.ok(plan.args.includes('--property=WorkingDirectory=/opt/anima/current/node_modules/@meetquinn/animactl'));
  assert.ok(plan.args.includes('--property=StandardOutput=append:/home/ubuntu/.anima/logs/runtime-upgrade.log'));
  assert.ok(plan.args.includes('--property=StandardError=append:/home/ubuntu/.anima/logs/runtime-upgrade.log'));
  assert.ok(plan.args.includes('--setenv=ANIMA_HOME=/home/ubuntu/.anima'));
  assert.ok(plan.args.includes('--setenv=PATH=/usr/bin:/bin'));
  assert.ok(!plan.args.some((arg) => arg.includes('ANIMA_AGENT_ID')));
  assert.equal(plan.args.at(-2), '--previous-started-at');
  assert.equal(plan.args.at(-1), '2026-06-29T05:00:00.000Z');
});

test('runtime upgrade worker keeps direct detached node spawn off Linux', () => {
  const plan = runtimeUpgradeWorkerSpawnPlan({
    animactlScript: '/opt/anima/current/node_modules/@meetquinn/animactl/dist/server/cli/animactl.js',
    animaHome: '/Users/totoday/.anima',
    dashboardHost: '127.0.0.1',
    dashboardPort: 4174,
    env: {
      ANIMA_INBOX_ITEM_ID: 'item_1',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    },
    logPath: '/Users/totoday/.anima/logs/runtime-upgrade.log',
    nodePath: '/opt/homebrew/bin/node',
    platform: 'darwin',
    previousVersion: '0.1.10',
    releaseTrack: 'stable',
    targetVersion: '0.1.11',
  });

  assert.equal(plan.command, '/opt/homebrew/bin/node');
  assert.equal(plan.detached, true);
  assert.equal(plan.stdio, 'log');
  assert.equal(plan.waitForExit, false);
  assert.equal(plan.cwd, '/opt/anima/current/node_modules/@meetquinn/animactl');
  assert.deepEqual(plan.args.slice(0, 5), [
    '/opt/anima/current/node_modules/@meetquinn/animactl/dist/server/cli/animactl.js',
    'runtime',
    'upgrade-worker',
    '--target-version',
    '0.1.11',
  ]);
  assert.equal(plan.env.ANIMA_HOME, '/Users/totoday/.anima');
  assert.equal(plan.env.ANIMA_INBOX_ITEM_ID, undefined);
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
    join(agentDir, 'wake-queue.json'),
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
          // fixed delay: simulated npm dist-tag lookup latency.
          await sleep(20);
          return '0.1.3';
        },
        now: () => new Date('2026-05-29T09:00:00.000Z'),
        packageVersion: async () => '0.1.1',
      });

      const status = await service.status();
      assert.equal(status.latestOnTrack, '0.1.2');
      assert.equal(status.releaseNotesUrl, 'https://github.com/MeetQuinn/anima/releases/tag/v0.1.2');
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
      assert.equal(status.releaseNotesUrl, undefined);
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
    // fixed delay: local waitFor poll interval, preserving this helper's failure shape.
    await sleep(10);
  }
  assert.fail('condition did not become true before timeout');
}
