import test from 'node:test';
import assert from 'node:assert/strict';

import type { ProviderChildHealthSnapshot } from '../../shared/snapshot.js';
import {
  CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW,
  CLAUDE_DISALLOWED_TOOLS,
  claudeAutoCompactWindowFor,
  claudeCommonArgs,
  claudeProviderEnv,
} from '../providers/claude-launch.js';
import { ControllerAgentRuntime } from '../providers/provider-runtime.js';
import type {
  AgentRuntimeEffects,
  AgentRuntimeFollowupResult,
  AgentRuntimeInput,
  AgentRuntimeResult,
} from '../providers/contract.js';

test('claude provider env defaults the auto-compact window and lets config env override it', () => {
  assert.deepEqual(claudeProviderEnv({ kind: 'claude-code' }), {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW),
  });
  assert.deepEqual(
    claudeProviderEnv({
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '120000', EXTRA: 'kept' },
      kind: 'claude-code',
    }),
    {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '120000',
      EXTRA: 'kept',
    },
  );
});

test('claude common args carry the shared launch flags and optional config flags', () => {
  assert.deepEqual(claudeCommonArgs({ kind: 'claude-code' }, undefined), [
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', CLAUDE_DISALLOWED_TOOLS.join(','),
  ]);
  assert.deepEqual(
    claudeCommonArgs(
      { kind: 'claude-code', model: 'opus', reasoningEffort: 'xhigh' },
      '/tmp/system-prompt.md',
    ),
    [
      '--permission-mode', 'bypassPermissions',
      '--disallowedTools', CLAUDE_DISALLOWED_TOOLS.join(','),
      '--model', 'opus',
      '--effort', 'xhigh',
      '--system-prompt-file', '/tmp/system-prompt.md',
    ],
  );
});

test('claude auto-compact window resolution keeps env override semantics', () => {
  assert.equal(claudeAutoCompactWindowFor('claude-code', undefined), CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW);
  assert.equal(claudeAutoCompactWindowFor('claude-code', {}), CLAUDE_DEFAULT_AUTO_COMPACT_WINDOW);
  assert.equal(claudeAutoCompactWindowFor('claude-code', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' }), 150000);
  assert.equal(claudeAutoCompactWindowFor('claude-code', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'invalid' }), undefined);
  assert.equal(claudeAutoCompactWindowFor('claude-code', { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '0' }), undefined);
  assert.equal(claudeAutoCompactWindowFor('codex-cli', undefined), undefined);
});

class FakeController {
  readonly completion: Promise<{ stdout: string; stderr: string }>;
  readonly killedWith: Array<NodeJS.Signals | undefined> = [];
  drainWaits = 0;
  private settleCompletion!: () => void;

  constructor() {
    this.completion = new Promise((resolve) => {
      this.settleCompletion = () => resolve({ stderr: '', stdout: '' });
    });
  }

  async acceptStderrChunk(_chunk: string): Promise<void> {}
  async acceptStdoutChunk(_chunk: string): Promise<void> {}

  kill(signal?: NodeJS.Signals): void {
    this.killedWith.push(signal);
    this.settleCompletion();
  }

  snapshot(): ProviderChildHealthSnapshot {
    return {
      alive: true,
      command: 'fake',
      exited: false,
      label: 'fake controller',
      startedAt: '2026-01-01T00:00:00.000Z',
      stdinWritable: true,
    };
  }

  async waitForQuiescent(_signal?: AbortSignal): Promise<void> {
    this.drainWaits += 1;
  }
}

class LifecycleProbeRuntime extends ControllerAgentRuntime<FakeController> {
  readonly env = undefined;
  readonly kind = 'fake-provider';
  turn: () => Promise<AgentRuntimeResult> = async () => ({});
  beforeFinishRun?: () => void;
  failurePayload?: (error: unknown) => Promise<Record<string, unknown>>;

  constructor(options: { providerChildIdleTimeoutMs?: number } = {}) {
    super(options);
  }

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    return this.runTurnLifecycle(input, {
      ...(this.beforeFinishRun ? { beforeFinishRun: this.beforeFinishRun } : {}),
      ...(this.failurePayload ? { failurePayload: this.failurePayload } : {}),
      label: 'Fake provider',
      startedPayload: { command: 'fake', transport: 'test' },
      turn: () => this.turn(),
    });
  }

  async appendToActiveRun(): Promise<AgentRuntimeFollowupResult> {
    return { accepted: false };
  }

  installController(controller: FakeController): FakeController {
    return this.slot.install(controller);
  }
}

function recordingEffects(): {
  effects: AgentRuntimeEffects;
  runtimeRecords: Array<{ payload?: Record<string, unknown>; type: string }>;
} {
  const runtimeRecords: Array<{ payload?: Record<string, unknown>; type: string }> = [];
  const effects: AgentRuntimeEffects = {
    persistProviderSession: async () => {},
    recordAgentText: async () => {},
    recordEvent: async () => {},
    recordOutput: async () => {},
    recordRuntime: async (type, payload) => {
      runtimeRecords.push({ type, ...(payload ? { payload } : {}) });
    },
    recordToolFailed: async () => {},
    recordToolStarted: async () => {},
  };
  return { effects, runtimeRecords };
}

function probeInput(effects: AgentRuntimeEffects, overrides: Partial<AgentRuntimeInput> = {}): AgentRuntimeInput {
  return {
    cwd: '/tmp',
    effects,
    env: {},
    itemId: 'item-1',
    prompt: 'prompt',
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; reject(error: unknown): void; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('controller runtime lifecycle records started and completed around the turn', async () => {
  const runtime = new LifecycleProbeRuntime();
  runtime.turn = async () => ({ text: 'done' });
  const { effects, runtimeRecords } = recordingEffects();

  const fresh = await runtime.run(probeInput(effects));
  assert.deepEqual(fresh, { text: 'done' });
  assert.deepEqual(runtimeRecords, [
    {
      payload: {
        command: 'fake',
        providerSession: { kind: 'fake-provider', resumed: false },
        transport: 'test',
      },
      type: 'runtime.started',
    },
    { type: 'runtime.completed' },
  ]);

  runtimeRecords.length = 0;
  await runtime.run(probeInput(effects, {
    providerSession: { id: 'session-9', updatedAt: '2026-01-01T00:00:00.000Z' },
  }));
  assert.deepEqual(runtimeRecords[0]?.payload?.['providerSession'], {
    id: 'session-9',
    kind: 'fake-provider',
    resumed: true,
  });
});

test('controller runtime lifecycle records the failure payload, runs hooks, and rethrows', async () => {
  const runtime = new LifecycleProbeRuntime();
  runtime.turn = async () => {
    throw new Error('turn exploded');
  };
  runtime.failurePayload = async () => ({ providerReason: 'test_reason' });
  let finishedBeforeRelease = false;
  runtime.beforeFinishRun = () => {
    finishedBeforeRelease = true;
  };
  const { effects, runtimeRecords } = recordingEffects();

  await assert.rejects(runtime.run(probeInput(effects)), /turn exploded/);
  assert.equal(finishedBeforeRelease, true);
  assert.deepEqual(runtimeRecords.map((record) => record.type), ['runtime.started', 'runtime.failed']);
  assert.deepEqual(runtimeRecords[1]?.payload, {
    error: 'turn exploded',
    providerReason: 'test_reason',
  });
  assert.equal(runtime.health().childExpected, false);
});

test('controller runtime lifecycle honors suppressFailureRecord but still runs the failure hook', async () => {
  const runtime = new LifecycleProbeRuntime();
  runtime.turn = async () => {
    throw new Error('suppressed failure');
  };
  let failureHookRan = false;
  runtime.failurePayload = async () => {
    failureHookRan = true;
    return {};
  };
  const { effects, runtimeRecords } = recordingEffects();

  await assert.rejects(runtime.run(probeInput(effects, { suppressFailureRecord: true })), /suppressed failure/);
  assert.equal(failureHookRan, true);
  assert.deepEqual(runtimeRecords.map((record) => record.type), ['runtime.started']);
});

test('controller runtime resets an idle provider child after the provider-child timeout', async () => {
  const runtime = new LifecycleProbeRuntime({ providerChildIdleTimeoutMs: 10 });
  const controller = runtime.installController(new FakeController());
  runtime.turn = async () => ({ text: 'done' });
  const { effects } = recordingEffects();

  await runtime.run(probeInput(effects));

  assert.deepEqual(controller.killedWith, []);
  assert.deepEqual(runtime.health(), { child: controller.snapshot(), childExpected: false });

  await waitFor(
    () => controller.killedWith.length === 1 && runtime.health().child === undefined,
    'provider child was not reset after becoming idle',
  );
  assert.deepEqual(controller.killedWith, ['SIGTERM']);
  assert.deepEqual(runtime.health(), { childExpected: false });
});

test('controller runtime cancels pending idle reset while another turn is active', async () => {
  const runtime = new LifecycleProbeRuntime({ providerChildIdleTimeoutMs: 20 });
  const controller = runtime.installController(new FakeController());
  runtime.turn = async () => ({ text: 'first' });
  const { effects } = recordingEffects();

  await runtime.run(probeInput(effects, { itemId: 'item-first' }));

  const gate = deferred<AgentRuntimeResult>();
  runtime.turn = () => gate.promise;
  const run = runtime.run(probeInput(effects, { itemId: 'item-second' }));
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(controller.killedWith, []);
  assert.equal(runtime.health().childExpected, true);

  gate.resolve({ text: 'second' });
  await run;

  await waitFor(
    () => controller.killedWith.length === 1 && runtime.health().child === undefined,
    'provider child was not reset after the second turn became idle',
  );
  assert.deepEqual(controller.killedWith, ['SIGTERM']);
});

test('controller runtime rejects overlapping runs for different items', async () => {
  const runtime = new LifecycleProbeRuntime();
  const gate = deferred<AgentRuntimeResult>();
  runtime.turn = () => gate.promise;
  const { effects } = recordingEffects();

  const first = runtime.run(probeInput(effects, { itemId: 'item-active' }));
  await assert.rejects(
    runtime.run(probeInput(effects, { itemId: 'item-other' })),
    /Fake provider runtime is already running item-active/,
  );
  gate.resolve({});
  await first;
  assert.equal(runtime.health().childExpected, false);
});

test('controller runtime health, drain, and close reflect the installed controller', async () => {
  const runtime = new LifecycleProbeRuntime();
  const controller = runtime.installController(new FakeController());
  assert.deepEqual(runtime.health(), { child: controller.snapshot(), childExpected: false });

  const gate = deferred<AgentRuntimeResult>();
  runtime.turn = () => gate.promise;
  const { effects } = recordingEffects();
  const run = runtime.run(probeInput(effects, { itemId: 'item-drain' }));

  await runtime.requestDrain({ activeItemId: 'item-other' });
  assert.equal(controller.drainWaits, 0);
  await runtime.requestDrain({ activeItemId: 'item-drain' });
  assert.equal(controller.drainWaits, 1);
  assert.equal(runtime.health().childExpected, true);

  gate.resolve({});
  await run;

  await runtime.close();
  assert.deepEqual(controller.killedWith, ['SIGTERM']);
  assert.deepEqual(runtime.health(), { childExpected: false });
});

test('controller runtime abort signal tears down the installed controller', async () => {
  const runtime = new LifecycleProbeRuntime();
  const controller = runtime.installController(new FakeController());
  const abort = new AbortController();
  const gate = deferred<AgentRuntimeResult>();
  runtime.turn = () => gate.promise;
  const { effects } = recordingEffects();

  const run = runtime.run(probeInput(effects, { signal: abort.signal, suppressFailureRecord: true }));
  abort.abort();
  gate.reject(new Error('aborted turn'));
  await assert.rejects(run, /aborted turn/);
  assert.deepEqual(controller.killedWith, ['SIGTERM']);
});
