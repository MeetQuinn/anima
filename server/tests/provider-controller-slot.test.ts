import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import { ProviderControllerSlot } from '../providers/controller-slot.js';
import { ControllerAgentRuntime } from '../providers/provider-runtime.js';
import type { AgentRuntimeInput } from '../providers/contract.js';

class Controller {
  readonly signals: NodeJS.Signals[] = [];
  readonly completion: Promise<void>;
  finish!: () => void;
  fail!: (error: Error) => void;

  constructor() {
    this.completion = new Promise((resolve, reject) => { this.finish = resolve; this.fail = reject; });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal);
    if (signal === 'SIGKILL') this.fail(new Error('killed'));
  }

  async acceptStderrChunk() {}
  async acceptStdoutChunk() {}
  async waitForQuiescent() {}
  snapshot() {
    return { alive: true, exited: false, command: 'synthetic', label: 'synthetic', startedAt: new Date(0).toISOString(), stdinWritable: true };
  }
}

test('reset retains the child and forces an ignored SIGTERM after five seconds by default', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slot = new ProviderControllerSlot<Controller>();
  const child = slot.install(new Controller());
  const reset = slot.reset();
  assert.equal(slot.get(), child);
  t.mock.timers.tick(4_999);
  assert.deepEqual(child.signals, ['SIGTERM']);
  t.mock.timers.tick(1);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  await reset;
  assert.equal(slot.get(), undefined);
});

test('a restart can shorten an already pending abort and clears both force timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slot = new ProviderControllerSlot<Controller>();
  const child = slot.install(new Controller());
  const abort = slot.reset();
  t.mock.timers.tick(100);
  const restart = slot.reset('SIGTERM', { forceAfterMs: 50 });
  t.mock.timers.tick(49);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGTERM']);
  t.mock.timers.tick(1);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGTERM', 'SIGKILL']);
  await Promise.all([abort, restart]);
  t.mock.timers.tick(10_000);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGTERM', 'SIGKILL']);
});

test('another reset never extends an earlier force deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slot = new ProviderControllerSlot<Controller>();
  const child = slot.install(new Controller());
  const first = slot.reset();
  t.mock.timers.tick(4_900);
  const second = slot.reset();
  t.mock.timers.tick(100);
  assert.equal(child.signals.at(-1), 'SIGKILL');
  await Promise.all([first, second]);
});

for (const failed of [false, true]) {
  test(`an exited child cancels force escalation (failed=${failed})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const slot = new ProviderControllerSlot<Controller>();
    const child = slot.install(new Controller());
    const reset = slot.reset();
    if (failed) child.fail(new Error('exit 1')); else child.finish();
    await reset;
    t.mock.timers.tick(10_000);
    assert.deepEqual(child.signals, ['SIGTERM']);
    assert.equal(slot.get(), undefined);
    await slot.reset();
  });
}

test('late termination cannot kill or clear a replacement controller', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slot = new ProviderControllerSlot<Controller>();
  const old = slot.install(new Controller());
  const reset = slot.reset();
  const replacement = slot.install(new Controller());
  t.mock.timers.tick(5_000);
  await reset;
  assert.equal(slot.get(), replacement);
  assert.deepEqual(old.signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(replacement.signals, []);
  replacement.finish();
});

class Runtime extends ControllerAgentRuntime<Controller> {
  readonly kind = 'test';
  readonly env = undefined;
  turns = 0;
  constructor(child: Controller) { super(); this.slot.install(child); }
  async appendToActiveRun() { return { accepted: false }; }
  run(input: AgentRuntimeInput) {
    return this.runTurnLifecycle(input, {
      label: 'test', startedPayload: {},
      turn: async () => {
        this.turns++;
        assert.equal(this.slot.get(), undefined, 'the next turn must not reuse a terminating child');
        return {};
      },
    });
  }
}

for (const cancel of [false, true]) {
  test(`a new turn waits for an in-flight idle reset (cancel=${cancel})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const child = new Controller();
    const runtime = new Runtime(child);
    const reset = runtime.close();
    const abort = new AbortController();
    const turn = runtime.run({
      cwd: '/tmp', itemId: 'synthetic', env: {}, prompt: '', signal: abort.signal,
      effects: {
        persistProviderSession: async () => {}, recordAgentText: async () => {},
        recordEvent: async () => {}, recordOutput: async () => {}, recordUsage: async () => {},
        recordRuntime: async () => {}, recordToolFailed: async () => {}, recordToolStarted: async () => {},
      },
    });
    const result = cancel ? assert.rejects(turn, (error) => error === 'user_stop') : turn;
    await setImmediate();
    assert.equal(runtime.turns, 0);
    assert.equal(runtime.health().child?.alive, true);
    if (cancel) abort.abort('user_stop');
    t.mock.timers.tick(5_000);
    await Promise.all([reset, result]);
    assert.equal(runtime.turns, cancel ? 0 : 1);
  });
}
