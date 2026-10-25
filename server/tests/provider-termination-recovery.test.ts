import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ClaudeCodeAgentRuntime } from '../providers/claude.js';
import { AgentRuntimeWorker } from '../runtime/runtime-worker.js';
import { activitiesForInboxItemWindow } from '../runtime/item-activities.js';
import { withAnimaHome } from './anima-home.js';
import { waitFor, withTimeout } from './helpers/harness.js';
import { enqueueInbox, queueFor, silentLogger } from './helpers/runtime-worker.js';
import { makeSlackEvent } from './helpers/slack.js';

async function text(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const mode of ['idle', 'stop', 'restart', 'restart-after-idle'] as const) {
  test(`a SIGTERM-ignoring Claude child recovers through ${mode}`, { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'anima-termination-'));
    const command = join(root, 'fake-claude.mjs');
    const calls = join(root, 'calls');
    const term = join(root, 'term');
    const ready = join(root, 'ready');
    // The first process hangs after accepting input. Its replacement completes
    // normally, so the test proves that the queue advances without replaying it.
    await writeFile(command, `
      import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => appendFileSync(${JSON.stringify(term)}, 'TERM\\n'));
      process.stdin.once('data', () => {
        const second = existsSync(${JSON.stringify(calls)});
        appendFileSync(${JSON.stringify(calls)}, String(process.pid) + '\\n');
        if (second) {
          process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\\n', () => process.exit(0));
        } else writeFileSync(${JSON.stringify(ready)}, String(process.pid));
      });
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `);
    let worker: AgentRuntimeWorker | undefined;
    let drain: Promise<number> | undefined;
    let closing: Promise<void> | undefined;
    let pid: number | undefined;
    try {
      await withAnimaHome(root, async () => {
        const runtime = () => new ClaudeCodeAgentRuntime({ kind: 'claude-code' }, process.execPath, [command]);
        const queue = queueFor('scout');
        const first = await enqueueInbox(makeSlackEvent({
          channelId: 'D-synthetic', teamId: 'T-synthetic', userId: 'U-synthetic',
          eventId: 'first', text: 'synthetic hang', ts: '1770000000.000001',
        }), { agentId: 'scout', stateDir: root, homePath: root });
        const options = { agentId: 'scout', stateDir: root, homePath: root, queue };
        worker = new AgentRuntimeWorker({
          ...options, agentRuntime: runtime(),
          idleTimeoutMs: mode === 'idle' || mode === 'restart-after-idle' ? 1000 : 60_000,
        }, silentLogger);
        drain = worker.drainOnce();
        await waitFor(async () => Boolean(await text(ready)));
        pid = Number(await text(ready));
        assert.ok(alive(pid));
        if (mode === 'stop') await queue.requestStop(first.item.id);
        if (mode !== 'restart') {
          await waitFor(async () => Boolean(await text(term)), { timeoutMs: 5_000 });
          assert.equal(worker.health().providerChild?.pid, pid, 'keep the terminating child visible to restart and health');
          assert.equal(worker.health().providerChild?.alive, true);
        }
        // Pause intake until the second item is queued; it must not be appended
        // to the canceled run. The current run continues settling normally.
        worker.setIntakePaused(true);
        const second = await queue.enqueue(makeSlackEvent({
          channelId: 'D-next', teamId: 'T-synthetic', userId: 'U-synthetic',
          eventId: 'second', text: 'next task', ts: '1770000000.000002',
        }));
        const restarting = mode === 'restart' || mode === 'restart-after-idle';
        if (restarting) {
          closing = worker.close({ abortReason: 'operator_restart', forceAfterMs: 50 });
          await withTimeout(closing, 2_000);
        }
        await withTimeout(drain, 8_000);
        assert.equal(alive(pid), false);
        assert.equal(await queue.find(first.item.id), undefined);
        assert.equal((await queue.find(second.item.id))?.handling.status, 'queued');
        const firstActivities = await activitiesForInboxItemWindow('scout', first.item.id);
        const reason = mode === 'stop' ? 'user_stop' : mode === 'restart' ? 'operator_restart' : 'idle_timeout';
        assert.equal(firstActivities.filter((row) => row.type === 'runtime.aborted').length, 1);
        assert.equal(firstActivities.find((row) => row.type === 'runtime.aborted')?.payload?.['reason'], reason);
        assert.equal(firstActivities.some((row) => row.payload?.['eventType'] === 'provider.crash.retry'), false);
        if (restarting) worker = new AgentRuntimeWorker({ ...options, agentRuntime: runtime() }, silentLogger);
        else worker.setIntakePaused(false);
        assert.equal(await withTimeout(worker.drainOnce(), 5_000), 1);
        assert.equal(await queue.find(second.item.id), undefined);
        const secondActivities = await activitiesForInboxItemWindow('scout', second.item.id);
        assert.equal(secondActivities.filter((row) => row.type === 'runtime.completed').length, 1);
        assert.equal((await text(calls)).trim().split('\n').length, 2, 'one canceled process and one next task, no replay');
      });
    } finally {
      // Kill only this fixture's processes even when a broken implementation
      // fails the assertions; never leave a SIGTERM-ignoring child behind.
      for (const value of (await text(calls)).trim().split('\n')) {
        const childPid = Number(value);
        if (childPid > 0 && alive(childPid)) process.kill(childPid, 'SIGKILL');
      }
      const unreadyPid = worker?.health().providerChild?.pid;
      if (unreadyPid && alive(unreadyPid)) process.kill(unreadyPid, 'SIGKILL');
      await closing;
      await drain;
      await worker?.close({ forceAfterMs: 50 });
      await rm(root, { recursive: true, force: true });
    }
  });
}
