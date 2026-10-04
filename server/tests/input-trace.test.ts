import assert from 'node:assert/strict';
import test from 'node:test';
import { withTempAnimaHome } from './helpers/harness.js';
import { makeSlackEvent } from './helpers/slack.js';
import { ingestEvent } from './helpers/inbox.js';
import { allActivities, loadState } from './helpers/state.js';
import { AgentRuntimeBridge } from '../runtime/runtime-bridge.js';
import { observeInputTrace } from '../providers/input-trace.js';

test('input trace allowlist excludes body, environment, paths and receipt extras', () => {
  const secret = 'private-body-credential-path-sentinel';
  const context = { batchId: 'batch', activeItemId: 'active', itemIds: ['one', 'two'],
    prompt: secret, env: { TOKEN: secret }, path: secret };
  const receipt = { controllerInstanceId: 'controller', nativeInputId: 'native', prompt: secret };
  const rows: Record<string, unknown>[] = [];
  observeInputTrace(async (row) => { rows.push(row); }, { phase: 'input.written', context, receipt });
  context.itemIds.push('later');
  assert.deepEqual(rows[0]?.['itemIds'], ['one', 'two']);
  assert.deepEqual(Object.keys(rows[0]!).sort(), [
    'eventType', 'observedAt', 'phase', 'batchId', 'activeItemId', 'itemIds',
    'controllerInstanceId', 'nativeInputId',
  ].sort());
  assert.equal(JSON.stringify(rows).includes(secret), false);
});

test('input trace never waits for observation and reports failures without error content', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  assert.equal(observeInputTrace(() => slow, { phase: 'input.prepared' }), undefined);
  const secret = 'private-network-error-sentinel';
  observeInputTrace(() => { throw new Error(secret); }, { phase: 'input.prepared' });
  observeInputTrace(async () => { throw new Error(secret); }, { phase: 'input.prepared' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(warnings, [
    ['Runtime input trace persistence failed'], ['Runtime input trace persistence failed'],
  ]);
  assert.equal(JSON.stringify(warnings).includes(secret), false);
  release();
});


test('real runtime event consumer persists input trace without claiming provider progress', async () => {
  await withTempAnimaHome(async (stateDir) => {
    const context = await ingestEvent(makeSlackEvent({ channelId: 'D-test', teamId: 'T-test', userId: 'U-test', text: 'bridge-body-sentinel' }), { agentId: 'anima', stateDir });
    let activity = 0;
    let progress = 0;
    const input = await new AgentRuntimeBridge({ kind: 'trace-test',
      run: async () => ({}), appendToActiveRun: async () => ({ accepted: false }),
    }).runInput({ context, onActivity: () => { activity += 1; }, onProviderProgress: () => { progress += 1; },
      profile: { displayName: 'Anima', transports: { feishu: false, slack: true } },
    });
    await input.effects.recordEvent({ eventType: 'runtime.input.trace', phase: 'input.prepared' });
    assert.equal(activity, 0);
    assert.equal(progress, 0);
    const rows = allActivities(await loadState()).filter((row) => row.payload?.['eventType'] === 'runtime.input.trace');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.payload?.['itemId'], context.item.id);
    await input.effects.recordEvent({ eventType: 'fixture.provider.event' });
    assert.equal(activity, 1);
  });
});
