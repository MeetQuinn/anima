import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import test, { mock } from 'node:test';

import { startChildProcess, terminateChildProcess } from '../providers/child-process.js';
import { withTimeout } from './helpers/harness.js';

// Observe real pipes without exposing queue internals in the production API.
function startObserved(input: Parameters<typeof startChildProcess>[0]) {
  const spy = mock.method(childProcess, 'spawn');
  syncBuiltinESMExports();
  try {
    const child = startChildProcess(input);
    return { child, raw: spy.mock.calls[0]!.result as ChildProcess };
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const producer = `
  const { once } = require('node:events');
  const chunk = 'é'.repeat(32768);
  (async () => {
    for (let i = 0; i < 128; i++) {
      for (const name of process.argv[1].split(',')) {
        if (!process[name].write(chunk)) await once(process[name], 'drain');
      }
    }
  })().catch(() => process.exitCode = 1);
`;

for (const streams of ['stdout', 'stderr', 'stdout,stderr']) {
  test(`child output bounds pending effects and preserves bytes/order for ${streams}`, { timeout: 15_000 }, async () => {
    const gate = deferred<void>();
    const pressure = deferred<'paused' | 'over-budget'>();
    const received: string[] = [];
    const consumed: string[] = [];
    let pending = 0;
    let peakPending = 0;
    let active = 0;
    let peakActive = 0;
    const digest = (name: string, chunk: string) => `${name}:${createHash('sha256').update(chunk).digest('hex')}`;
    const consume = (name: string) => async (chunk: string) => {
      peakActive = Math.max(peakActive, ++active);
      await gate.promise;
      await setImmediate();
      consumed.push(digest(name, chunk));
      pending -= Buffer.byteLength(chunk);
      active--;
    };
    const { child, raw } = startObserved({
      command: process.execPath, args: ['-e', producer, streams], env: process.env,
      label: 'bounded output', bufferOutput: false,
      onStdoutChunk: consume('stdout'), onStderrChunk: consume('stderr'),
    });
    const completion = child.completion;
    void completion.catch(() => {});
    let bytes = 0;
    for (const name of ['stdout', 'stderr'] as const) {
      raw[name]!.on('data', (chunk: string) => {
        received.push(digest(name, chunk));
        const size = Buffer.byteLength(chunk);
        bytes += size;
        peakPending = Math.max(peakPending, pending += size);
        if (pending > 2 * 1024 * 1024) pressure.resolve('over-budget');
      });
      raw[name]!.on('pause', () => {
        if (raw.stdout!.isPaused() && raw.stderr!.isPaused()) pressure.resolve('paused');
      });
    }
    try {
      assert.equal(await withTimeout(pressure.promise, 5000), 'paused', 'a blocked consumer must backpressure both pipes before retaining 2 MiB');
      gate.resolve();
      assert.deepEqual(await withTimeout(completion, 5000), { stdout: '', stderr: '' });
      assert.equal(bytes, streams.split(',').length * 128 * 65536);
      assert.deepEqual(consumed, received, 'effects must preserve the observed stdout/stderr order and every decoded chunk');
      assert.ok(peakPending <= 2 * 1024 * 1024, `peak pending bytes: ${peakPending}`);
      assert.equal(pending, 0);
      assert.equal(peakActive, 1);
    } finally {
      gate.resolve();
      raw.stdout?.resume();
      raw.stderr?.resume();
      await terminateChildProcess(child, { forceAfterMs: 100 });
    }
  });
}

test('a failed output effect releases pressure and completion still reports the child exit', { timeout: 15_000 }, async () => {
  let bytes = 0;
  let first = true;
  const child = startChildProcess({
    command: process.execPath,
    args: ['-e', producer.replace('})().catch', 'process.exitCode = 7; })().catch'), 'stdout,stderr'],
    env: process.env, label: 'failed effect', bufferOutput: false,
    onStdoutChunk: async (chunk) => {
      bytes += Buffer.byteLength(chunk);
      await setImmediate();
      if (first) { first = false; throw new Error('consumer failed'); }
    },
    onStderrChunk: async (chunk) => { bytes += Buffer.byteLength(chunk); await setImmediate(); },
  });
  await assert.rejects(child.completion, /failed effect exited with code 7\nstream effect failed: consumer failed/);
  assert.equal(bytes, 16 * 1024 * 1024);
});

for (const stop of ['abort', 'terminate'] as const) {
  test(`${stop} stops a child whose output is backpressured`, { timeout: 15_000 }, async () => {
    const gate = deferred<void>();
    const paused = deferred<void>();
    const controller = new AbortController();
    const { child, raw } = startObserved({
      command: process.execPath, args: ['-e', producer, 'stdout,stderr'], env: process.env,
      label: 'stopped output', bufferOutput: false, signal: controller.signal,
      onStdoutChunk: async () => gate.promise, onStderrChunk: async () => gate.promise,
    });
    const rejected = assert.rejects(child.completion, /terminated by SIGTERM/);
    raw.stderr!.once('pause', () => paused.resolve());
    try {
      await withTimeout(paused.promise, 5000);
      if (stop === 'abort') controller.abort();
      const stopping = stop === 'terminate' ? terminateChildProcess(child, { forceAfterMs: 1000 }) : undefined;
      gate.resolve();
      await rejected;
      if (stopping) assert.equal((await stopping).forced, false);
      assert.equal(child.snapshot().exited, true);
    } finally {
      gate.resolve();
      raw.stdout?.resume();
      raw.stderr?.resume();
      await terminateChildProcess(child, { forceAfterMs: 100 });
    }
  });
}
