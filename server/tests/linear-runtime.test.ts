import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { startRunningAgent } from '../runtime/agent-runner.js';
import { TeamRunLimiter } from '../runtime/team-run-limiter.js';
import type { AgentRuntimeInput } from '../providers/contract.js';
import { registerLinearCommands } from '../tools/linear-cli.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { SessionStore } from '../storage/schema/session.store.js';
import { withTempAnimaHome, waitFor } from './helpers/harness.js';
import { created, install, seedLinear, sessionId, prompted } from './helpers/linear.js';
import { makeSlackEvent } from './helpers/slack.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';

for (const queued of [false, true]) test(`Linear-only runtime and registered CLI report through the existing primary session, queued=${queued}`, async (t) => withTempAnimaHome(async (home) => {
  const { service, fake, agentStore } = await seedLinear(home); t.mock.method(globalThis, 'fetch', fake.fetch);
  t.mock.method(console, 'log', () => {});
  t.mock.getter(process, 'stdin', () => Readable.from(['Synthetic delivered response']) as typeof process.stdin);
  const calls: AgentRuntimeInput[] = [];
  const runtime = {
    kind: 'synthetic',
    async run(input: AgentRuntimeInput) {
      calls.push(input);
      await input.effects.persistProviderSession({ id: 'one-primary-session', updatedAt: new Date().toISOString() });
      if (input.prompt.includes('Linear')) {
        const cli = new Command(); registerLinearCommands(cli);
        await cli.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', 'respond', '--session', sessionId]);
      }
      return { text: 'synthetic completion' };
    },
    async appendToActiveRun() { return { accepted: false }; },
    async close() {},
  };
  const limiter = new TeamRunLimiter(1); const release = queued ? await limiter.acquire() : undefined;
  const runner = await startRunningAgent({ agentId: 'scout', agentRuntime: runtime, animaHome: home, stateDir: home,
    homePath: (await agentStore.read()).homePath!, runtimeEnv: {}, runLimiter: limiter });
  try {
    await service.receive(created(), install); await service.tick();
    if (queued) { assert.equal(fake.posts[0]!.content.type, 'thought'); assert.equal(calls.length, 0); release!(); }
    await waitFor(() => fake.posts.some((p) => p.content.type === 'response'), { timeoutMs: 3000 });
    await waitFor(async () => (await new WakeQueueService('scout').list()).length === 0, { timeoutMs: 3000 });
    assert.equal(fake.posts.filter((p) => p.content.type === 'response').length, 1);
    const messages = await messageServiceForAgent('scout').list();
    assert.ok(messages.entries.some((m) => m.direction === 'out' && m.platform === 'linear' && m.channelId === sessionId && m.threadTs === sessionId && m.text === 'Synthetic delivered response'));
    for (const input of calls) assert.doesNotMatch(JSON.stringify([input.env, input.systemPrompt]), /access-sentinel|refresh-sentinel|signing-secret/);
    await service.receive(prompted(), install);
    await waitFor(() => calls.length === 2, { timeoutMs: 3000 });
    assert.equal(calls[1]!.providerSession?.id, 'one-primary-session');
    await waitFor(async () => (await new WakeQueueService('scout').list()).length === 0, { timeoutMs: 3000 });
    await new WakeQueueService('scout').enqueue(makeSlackEvent({ eventId: 'synthetic-slack-control', channelId: 'D-control', userId: 'U-control', ts: '1770000010.000001', text: 'Slack control', teamId: 'T-synthetic' }));
    await waitFor(() => calls.length === 3, { timeoutMs: 3000 });
    assert.equal(calls[2]!.providerSession?.id, 'one-primary-session');
    assert.equal((await new SessionStore('scout').read())?.current?.id, 'one-primary-session');
  } finally { release?.(); await runner.stop(); }
}));

test('a completed provider turn without a platform reply ends the Linear session with an accurate error', async (t) => withTempAnimaHome(async (home) => {
  const { service, fake, agentStore, store } = await seedLinear(home);
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const runtime = {
    kind: 'synthetic',
    async run() { return { text: 'Final text without a Linear tool call' }; },
    async appendToActiveRun() { return { accepted: false }; },
    async close() {},
  };
  const runner = await startRunningAgent({ agentId: 'scout', agentRuntime: runtime, animaHome: home, stateDir: home,
    homePath: (await agentStore.read()).homePath!, runtimeEnv: {}, runLimiter: new TeamRunLimiter(1) });
  try {
    await service.receive(created(), install);
    await waitFor(() => fake.posts.some((p) => p.content.type === 'error'));
    assert.match(fake.posts.find((p) => p.content.type === 'error')!.content.body, /ended without a confirmed Linear response/);
    assert.equal(fake.posts.filter((p) => p.content.type === 'response').length, 0);
    await waitFor(async () => {
      const receipt = Object.values((await store.read()).receipts)[0];
      return receipt?.settled === true && receipt.answered === true;
    });
    const receipt = Object.values((await store.read()).receipts)[0]!;
    assert.ok(receipt.settled && receipt.answered);
    await service.tick();
    assert.equal(fake.posts.length, 1);
  } finally { await runner.stop(); }
}));
