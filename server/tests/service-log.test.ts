import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, writeSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  rotateOwnServiceLogIfNeeded,
  rotateServiceLogIfNeeded,
  startLiveServiceLogRotation,
} from '../services/service-log.js';
import { FULL_SERVICE_LOG_BYTES, runAnimactlWith, writeFakeServiceManager } from './helpers/service-manager.js';

// The launchd start test lives in services.test.ts, which CI runs on macOS.
// This file is in the unit tier, which CI runs on Linux, so the systemd start
// test below runs there.

test('service log rotation moves each generation up and drops the oldest', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-service-log-rotate-'));
  try {
    const path = join(tempDir, 'agent.log');
    await writeFile(path, 'current');
    for (let index = 1; index <= 5; index += 1) await writeFile(`${path}.${index}`, `gen${index}`);

    await rotateServiceLogIfNeeded(path, { maxBytes: 'current'.length });

    await assert.rejects(stat(path), /ENOENT/);
    assert.equal(await readFile(`${path}.1`, 'utf8'), 'current');
    for (let index = 2; index <= 5; index += 1) {
      assert.equal(await readFile(`${path}.${index}`, 'utf8'), `gen${index - 1}`);
    }
    await assert.rejects(stat(`${path}.6`), /ENOENT/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('service log rotation skips a small or missing log and tolerates gaps', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-service-log-rotate-gaps-'));
  try {
    const path = join(tempDir, 'agent.log');
    await rotateServiceLogIfNeeded(path, { maxBytes: 1 });
    await assert.rejects(stat(path), /ENOENT/);

    await writeFile(path, 'small');
    await rotateServiceLogIfNeeded(path, { maxBytes: 'small'.length + 1 });
    assert.equal(await readFile(path, 'utf8'), 'small');
    await assert.rejects(stat(`${path}.1`), /ENOENT/);

    await writeFile(`${path}.1`, 'gen1');
    await writeFile(`${path}.3`, 'gen3');
    await rotateServiceLogIfNeeded(path, { maxBytes: 'small'.length });
    assert.equal(await readFile(`${path}.1`, 'utf8'), 'small');
    assert.equal(await readFile(`${path}.2`, 'utf8'), 'gen1');
    await assert.rejects(stat(`${path}.3`), /ENOENT/);
    assert.equal(await readFile(`${path}.4`, 'utf8'), 'gen3');
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test(
  'service log rotation failure warns and keeps the log where it was',
  { skip: process.getuid?.() === 0 ? 'root ignores directory permissions' : false },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'anima-service-log-rotate-fail-'));
    const logDir = join(tempDir, 'logs');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    try {
      await mkdir(logDir);
      const path = join(logDir, 'agent.log');
      await writeFile(path, 'current');
      await chmod(logDir, 0o555);
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };

      await rotateServiceLogIfNeeded(path, { maxBytes: 1 });

      console.warn = originalWarn;
      assert.equal(await readFile(path, 'utf8'), 'current');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /log rotation skipped for .*agent\.log/);
    } finally {
      console.warn = originalWarn;
      await chmod(logDir, 0o755).catch(() => {});
      await rm(tempDir, { force: true, recursive: true });
    }
  },
);

test('live log rotation copies an append-mode log to .1 and truncates it in place', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-live-log-rotate-'));
  const path = join(tempDir, 'agent.log');
  const fd = openSync(path, 'a');
  try {
    for (let index = 1; index <= 5; index += 1) await writeFile(`${path}.${index}`, `gen${index}`);
    writeSync(fd, 'first line\n');

    assert.equal(rotateOwnServiceLogIfNeeded(path, { fd, maxBytes: 1_000 }), 'under-limit');
    assert.equal(await readFile(path, 'utf8'), 'first line\n');

    assert.equal(rotateOwnServiceLogIfNeeded(path, { fd, maxBytes: 'first line\n'.length }), 'rotated');
    assert.equal(await readFile(`${path}.1`, 'utf8'), 'first line\n');
    for (let index = 2; index <= 5; index += 1) {
      assert.equal(await readFile(`${path}.${index}`, 'utf8'), `gen${index - 1}`);
    }
    await assert.rejects(stat(`${path}.6`), /ENOENT/);
    assert.equal((await stat(path)).size, 0);

    // The next write lands at the start of the emptied file, with no hole.
    writeSync(fd, 'next line\n');
    assert.equal(await readFile(path, 'utf8'), 'next line\n');
  } finally {
    closeSync(fd);
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('live log rotation leaves a non-append fd and a foreign file untouched', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-live-log-rotate-guard-'));
  const path = join(tempDir, 'agent.log');
  const other = join(tempDir, 'other.log');
  // `> agent.log` style: write-only and not append, offset at the end.
  const plainFd = openSync(path, 'w');
  const otherFd = openSync(other, 'a');
  try {
    writeSync(plainFd, 'kept as is\n');
    writeSync(otherFd, 'not the service log\n');

    assert.equal(rotateOwnServiceLogIfNeeded(path, { fd: otherFd, maxBytes: 1 }), 'not-own-log');
    assert.equal(rotateOwnServiceLogIfNeeded(path, { fd: plainFd, maxBytes: 1 }), 'not-append');
    assert.equal(await readFile(path, 'utf8'), 'kept as is\n');
    assert.equal(await readFile(other, 'utf8'), 'not the service log\n');
    await assert.rejects(stat(`${path}.1`), /ENOENT/);
    assert.equal(rotateOwnServiceLogIfNeeded(join(tempDir, 'missing.log'), { fd: otherFd, maxBytes: 1 }), 'not-own-log');
  } finally {
    closeSync(plainFd);
    closeSync(otherFd);
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('live log rotation timer turns itself off when stdout does not append', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-live-log-rotate-off-'));
  const path = join(tempDir, 'agent.log');
  const fd = openSync(path, 'w');
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  const rotation = startLiveServiceLogRotation(path, { fd, intervalMs: 5, maxBytes: 1 });
  try {
    writeSync(fd, 'kept\n');
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /live log rotation off for .*agent\.log: stdout does not append/);
    await assert.rejects(stat(`${path}.1`), /ENOENT/);
  } finally {
    rotation.stop();
    console.warn = originalWarn;
    closeSync(fd);
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('live log rotation keeps every stdout line of a running service', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-live-log-rotate-child-'));
  const path = join(tempDir, 'agent.log');
  // Detached starts open the log like this; launchd and systemd also append.
  const fd = openSync(path, 'a');
  try {
    const moduleUrl = pathToFileURL(resolve('dist/server/services/service-log.js')).href;
    const script = [
      `const { rotateOwnServiceLogIfNeeded } = await import(${JSON.stringify(moduleUrl)});`,
      `const path = ${JSON.stringify(path)};`,
      'const results = [];',
      'for (let line = 0; line < 400; line += 1) {',
      "  console.log(`line ${String(line).padStart(4, '0')}`);",
      '  if (line % 50 === 49) results.push(rotateOwnServiceLogIfNeeded(path, { keep: 20, maxBytes: 200 }));',
      '}',
      "console.error(JSON.stringify(results));",
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', fd, 'pipe'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
    const results = JSON.parse(stderr.trim().split('\n').at(-1) ?? '[]') as string[];
    assert.deepEqual(results, Array.from({ length: 8 }, () => 'rotated'));

    const generations: string[] = [];
    for (let index = 8; index >= 1; index -= 1) generations.push(await readFile(`${path}.${index}`, 'utf8'));
    generations.push(await readFile(path, 'utf8'));
    const all = generations.join('');
    assert.equal(all.includes('\0'), false);
    assert.deepEqual(
      all.trim().split('\n'),
      Array.from({ length: 400 }, (_, line) => `line ${String(line).padStart(4, '0')}`),
    );
  } finally {
    closeSync(fd);
    await rm(tempDir, { force: true, recursive: true });
  }
});

test(
  'systemd start rotates a full service log before systemd opens it',
  { skip: process.platform !== 'linux' ? 'systemd is Linux only' : false },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'anima-systemd-log-rotate-'));
    try {
      const fake = await writeFakeServiceManager(tempDir, 'systemctl');
      const unitDir = join(fake.home, '.config', 'systemd', 'user');
      await mkdir(unitDir, { recursive: true });
      await writeFile(join(unitDir, 'ai.meetquinn.anima.agent.service'), '[Unit]\n');

      const started = await runAnimactlWith(['services', 'start', '--only', 'agent'], fake.env);
      assert.equal(started.status, 0, started.stderr || started.stdout);
      assert.deepEqual(await fake.actions(), ['start rotated=yes']);
      assert.equal((await stat(`${fake.logPath}.1`)).size, FULL_SERVICE_LOG_BYTES);
      await assert.rejects(stat(fake.logPath), /ENOENT/);

      // A running service keeps its open log: no rotation, no systemctl action.
      await writeFile(fake.logPath, 'live\n');
      await truncate(fake.logPath, FULL_SERVICE_LOG_BYTES);
      await rm(fake.callsPath, { force: true });
      const again = await runAnimactlWith(['services', 'start', '--only', 'agent'], fake.env);
      assert.equal(again.status, 0, again.stderr || again.stdout);
      assert.deepEqual(await fake.actions(), []);
      assert.equal((await stat(fake.logPath)).size, FULL_SERVICE_LOG_BYTES);
      await assert.rejects(stat(`${fake.logPath}.2`), /ENOENT/);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  },
);
