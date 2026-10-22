import test from 'node:test';
import { createServer } from 'node:net';
import { RuntimeHost } from '../runtime/host.js';
import { AgentHealthStore } from '../runtime/agent-health.store.js';
import { AgentHealthService } from '../runtime/agent-health.service.js';
import { WakeQueueStore } from '../storage/schema/wake-queue.store.js';
import { ServerConfigStore } from '../storage/schema/server.store.js';
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentRuntime } from '../providers/factory.js';
import { runtimeTestEnv } from './helpers/agent-runtime.js';
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
import { LinearSessionService } from '../linear/session.service.js';
import { LinearStore } from '../storage/schema/linear.store.js';
import { signalWake } from '../inbox/wake-signal.js';
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

for (const shared of [false, true]) for (const outcome of ['completed', 'failed', 'interrupted'] as const) for (const fault of [false, true]) {
  test(`accepted Linear ownership survives start journal failure: shared=${shared}, ${outcome}, fault=${fault}`, async (t) => withTempAnimaHome(async (home) => {
    const { service, fake, agentStore, store } = await seedLinear(home);
    t.mock.method(globalThis, 'fetch', fake.fetch);
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
    let injected = false, runs = 0, appends = 0;
    const update = LinearStore.prototype.update;
    t.mock.method(LinearStore.prototype, 'update', function (this: LinearStore, op: Parameters<LinearStore['update']>[0]) {
      return update.call(this, async (file) => {
        const next = await op(file);
        const ownershipWrite = Object.entries(next.receipts).some(([id, r]) => r.runItemId && !file.receipts[id]?.runItemId);
        if (fault && !injected && ownershipWrite) { injected = true; throw new Error('Synthetic ownership journal unavailable once'); }
        return next;
      });
    });
    const queue = new WakeQueueService('scout');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let actualRoot!: string;
    const runtime = {
      kind: 'synthetic',
      async run(input: AgentRuntimeInput) {
        runs++; actualRoot = input.itemId;
        await Promise.race([gate, new Promise<never>((_resolve, reject) => {
          input.signal!.addEventListener('abort', () => reject(new Error('Synthetic interrupted run')), { once: true });
        })]);
        if (outcome === 'failed') throw new Error('Synthetic provider failure');
        return { text: 'Synthetic completion without platform response' };
      },
      async appendToActiveRun() { appends++; return { accepted: true }; },
      async close() { release(); },
    };
    if (shared) await queue.enqueue(makeSlackEvent({ eventId: 'synthetic-root', channelId: 'D-control', userId: 'U-control', ts: '1770000020.000001', text: 'Synthetic root', teamId: 'T-control' }));
    else { await service.receive(created(), install); await service.tick(); }
    const runner = await startRunningAgent({ agentId: 'scout', agentRuntime: runtime, animaHome: home, stateDir: home,
      homePath: (await agentStore.read()).homePath!, runtimeEnv: {}, runLimiter: new TeamRunLimiter(1) });
    try {
      await waitFor(() => runs === 1);
      if (shared) { await service.receive(created(), install); await service.tick(); await waitFor(() => appends === 1); }
      await waitFor(async () => fault ? injected : Object.values((await store.read()).receipts).some((r) => r.runItemId));
      if (shared) assert.equal((await queue.list()).find((i) => i.kind === 'linear')!.handling.appendedToItemId, actualRoot);
      if (outcome === 'interrupted') await queue.requestStop(actualRoot); else release();
      await waitFor(async () => Object.values((await store.read()).receipts).every((r) => r.answered), { timeoutMs: 3000 });
      await waitFor(async () => Object.values((await store.read()).receipts).every((r) => r.settled), { timeoutMs: 3000 });
      await service.tick();
      await waitFor(async () => (await queue.list()).length === 0, { timeoutMs: 3000 });
      const receipt = Object.values((await store.read()).receipts)[0]!;
      const notices = fake.posts.filter((p) => p.content.type === 'error');
      assert.equal(injected, fault); assert.equal(runs, 1); assert.equal(appends, shared ? 1 : 0);
      assert.equal(notices.length, 1, 'Accepted input must receive a final notice despite a transient ownership write failure');
      assert.match(notices[0]!.content.body, outcome === 'completed' ? /ended without a confirmed/ : outcome === 'failed' ? /model run failed/ : /interrupted/);
      assert.equal(receipt.runItemId, actualRoot); assert.equal(receipt.answered, true);
      assert.equal(receipt.item, undefined);
      const posts = fake.posts.length;
      await service.receive(created(), install); await service.tick();
      assert.equal((await queue.list()).length, 0); assert.equal(fake.posts.length, posts); assert.equal(runs, 1);
    } finally { release(); await runner.stop(); }
  }));
}


for (const finish of ['late-reply', 'idle', 'stop'] as const) test(`Linear progress survives a background hour and closes only on ${finish}`, async (t) => withTempAnimaHome(async (home) => {
  const { service, fake, agentStore, store } = await seedLinear(home);
  t.mock.method(globalThis, 'fetch', fake.fetch);
  t.mock.method(console, 'log', () => {});
  let body = 'Started';
  t.mock.getter(process, 'stdin', () => Readable.from([body]) as typeof process.stdin);
  const reply = async (kind: string) => {
    const cli = new Command(); registerLinearCommands(cli);
    await cli.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', 'respond', '--session', sessionId, '--kind', kind]);
  };
  let background = true, runs = 0, idleChecks = 0;
  const inputs: string[] = [];
  const completeIdleRuns = LinearSessionService.prototype.completeIdleRuns;
  t.mock.method(LinearSessionService.prototype, 'completeIdleRuns', async function (this: LinearSessionService, idle: () => Promise<boolean>) {
    try { await completeIdleRuns.call(this, idle); } finally { idleChecks++; }
  });
  const runtime = {
    kind: 'synthetic',
    isProviderQuiescent: () => !background,
    async run(input: AgentRuntimeInput) {
      runs++; inputs.push(input.itemId);
      if (runs === 1) await reply('thought');
      else {
        for (let i = 0; i < 2; i++) {
          const cli = new Command(); registerLinearCommands(cli);
          await cli.parseAsync(['node', 'anima', 'linear', '--agent', 'scout', 'attach-pr', '--session', sessionId,
            '--url', 'https://github.com/example/repo/pull/1']);
        }
        body = 'Finished'; await reply('response'); await reply('response');
      }
      return { text: 'Synthetic completion' };
    },
    async appendToActiveRun() { return { accepted: false }; },
    async close() {},
  };
  const queue = new WakeQueueService('scout');
  await service.receive(created(), install);
  const runner = await startRunningAgent({ agentId: 'scout', agentRuntime: runtime, animaHome: home, stateDir: home,
    homePath: (await agentStore.read()).homePath!, runtimeEnv: {}, runLimiter: new TeamRunLimiter(1) });
  const checkIdle = async () => { const before = idleChecks; signalWake('scout'); await waitFor(() => idleChecks > before); };
  try {
    await waitFor(() => idleChecks > 0);
    assert.equal(runs, 1);
    assert.equal((await queue.list()).length, 0);
    const first = Object.values((await store.read()).receipts)[0]!;
    assert.equal(first.settled, true); assert.notEqual(first.answered, true);
    assert.deepEqual(fake.posts.map((p) => p.content), [{ type: 'thought', body: 'Started' }]);
    // Advance wall time, not timers or a real paid provider call.
    const now = Date.now(); t.mock.method(Date, 'now', () => now + 60 * 60_000);
    await checkIdle();
    assert.equal(fake.posts.length, 1, 'Background work keeps the request open after an hour');
    if (finish === 'stop') {
      await service.receive(prompted(sessionId, true), install);
      await assert.rejects(service.respond(sessionId, 'response', 'Too late', inputs[0]), /No accepted input/);
      assert.match(fake.posts.at(-1)!.content.body, /Stopped accepting replies/);
    } else {
      const wake = makeSlackEvent({ eventId: 'late-followup', channelId: 'D-control', userId: 'U-control', ts: '1770000030.000001', text: 'Continue work', teamId: 'T-control' });
      // Staged publication avoids a race with the worker while setting notBefore.
      await queue.enqueueStaged(wake);
      await queue.requeueDeferred(wake.id, { deferrals: 1, notBefore: new Date(Date.now() + 60_000).toISOString() });
      background = false;
      await checkIdle();
      assert.equal(fake.posts.length, 1, 'A deferred queued wake also keeps the request open');
      if (finish === 'late-reply') {
        await queue.requeue(wake.id); await queue.publishQueued(wake.id);
        await waitFor(() => fake.posts.some((p) => p.content.type === 'response'));
        await waitFor(() => idleChecks >= 4);
        assert.notEqual(inputs[0], inputs[1], 'The final reply comes from a later inbox item');
        assert.deepEqual(fake.links, ['https://github.com/example/repo/pull/1']);
        assert.deepEqual(fake.posts.map((p) => p.content), [{ type: 'thought', body: 'Started' }, { type: 'response', body: 'Finished' }]);
      } else {
        await queue.fail(wake.id); await checkIdle();
        assert.match(fake.posts.at(-1)!.content.body, /ended without a confirmed Linear response/);
      }
    }
    await checkIdle();
    assert.equal(fake.posts.length, 2, 'No duplicate reply or fallback after closure');
    assert.ok(Object.values((await store.read()).receipts).filter((r) => r.itemId).every((r) => r.answered));
  } finally { await runner.stop(); }
}));


test('Claude native background rewake keeps Linear reply ownership across the empty-list gap', async (t) => withTempAnimaHome(async (home) => {
  const { service, fake, agentStore, store } = await seedLinear(home);
  t.mock.method(globalThis, 'fetch', fake.fetch); t.mock.method(console, 'log', () => {});
  const release = join(home, 'release'), finish = join(home, 'finish');
  const fakeClaude = join(home, 'claude');
  await writeFile(fakeClaude, [
    '#!/usr/bin/env node',
    "import { existsSync } from 'node:fs';",
    "import readline from 'node:readline';",
    "const send = m => process.stdout.write(JSON.stringify({...m, session_id:'linear-native'}) + '\\n');",
    "send({type:'system', subtype:'init', cwd:process.cwd(), claude_code_version:'test'});",
    "readline.createInterface({input:process.stdin}).once('line',()=>{",
    "send({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'work',task_type:'mcp_task'}]});",
    "send({type:'result',subtype:'success',result:'background work'});",
    "let phase=0; const timer=setInterval(()=>{",
    "if(phase===0 && existsSync(process.env.RELEASE_PATH)){phase=1;send({type:'system',subtype:'background_tasks_changed',tasks:[]});}",
    "if(phase===1 && existsSync(process.env.FINISH_PATH)){phase=2;clearInterval(timer);",
    "send({type:'system',subtype:'task_notification',task_id:'work',status:'completed',output_file:'',summary:'Done'});",
    "send({type:'system',subtype:'turn_starting',mode:'task-notification',task_id:'work'});",
    "send({type:'assistant',message:{content:[{type:'text',text:'native result'}]}});",
    "send({type:'result',subtype:'success',result:'native result'});}",
    "},5);});",
  ].join('\n'));
  await chmod(fakeClaude, 0o755);
  const runtime = createAgentRuntime({kind:'claude-code', env:runtimeTestEnv(home,{RELEASE_PATH:release,FINISH_PATH:finish})});
  let idleChecks = 0;
  const completeIdleRuns = LinearSessionService.prototype.completeIdleRuns;
  t.mock.method(LinearSessionService.prototype, 'completeIdleRuns', async function (this: LinearSessionService, idle: () => Promise<boolean>) {
    try { await completeIdleRuns.call(this, idle); } finally { idleChecks++; }
  });
  await service.receive(created(), install);
  const runner = await startRunningAgent({agentId:'scout',agentRuntime:runtime,animaHome:home,stateDir:home,
    homePath:(await agentStore.read()).homePath!,runtimeEnv:{},runLimiter:new TeamRunLimiter(1)});
  try {
    await waitFor(()=>idleChecks>0);
    assert.equal(runtime.isProviderQuiescent?.(),false);
    assert.equal(runtime.health?.().providerWork?.backgroundTaskCount,1);
    const receipt = Object.values((await store.read()).receipts)[0]!;
    assert.equal(receipt.settled,true); assert.notEqual(receipt.answered,true); assert.ok(receipt.runItemId);
    await writeFile(release,'1');
    await waitFor(()=>runtime.health?.().providerWork?.state==='working' && !runtime.health?.().providerWork?.backgroundTaskCount);
    assert.equal(runtime.isProviderQuiescent?.(),false,'Empty list is followed by a pending native rewake');
    const before=idleChecks;signalWake('scout');await waitFor(()=>idleChecks>before);
    assert.equal(fake.posts.length,0);
    // Same original owner, as in the long-lived provider subprocess environment.
    await service.respond(sessionId,'response','Native task finished',receipt.runItemId);
    await writeFile(finish,'1');
    await waitFor(()=>runtime.isProviderQuiescent?.()===true);
    const after=idleChecks;signalWake('scout');await waitFor(()=>idleChecks>after);
    assert.deepEqual(fake.posts.map(p=>p.content),[{type:'response',body:'Native task finished'}]);
  } finally {await runner.stop();}
}));


for (const failedPublish of [false, true]) for (const stop of [false, true]) test(`Linear background ownership survives a host restart: queue failure=${failedPublish}, Stop=${stop}`, async (t) => withTempAnimaHome(async (home) => {
  const { service, fake, agentStore, store } = await seedLinear(home);
  t.mock.method(globalThis, 'fetch', fake.fetch);
  t.mock.method(console, 'log', () => {});
  const queue = new WakeQueueService('scout');
  await service.receive(created(), install);
  const original = (await queue.list())[0]!;
  await service.markStarted(original, original.id);
  await service.respond(sessionId, 'thought', 'Started before restart', original.id);
  await queue.complete(original.id); await service.markSettled(original);
  const healthStore = new AgentHealthStore({ animaHome: home });
  await new AgentHealthService(healthStore).writeHealth({ agentId: 'scout', state: 'healthy', updatedAt: new Date().toISOString(),
    runtime: { processId: process.pid + 100_000, providerChildExpected: true, providerWork: { state: 'background', backgroundTaskCount: 1 } } });
  let attempts = 0, runs = 0, refused = false;
  const insert = WakeQueueStore.prototype.insertIfAbsent;
  t.mock.method(WakeQueueStore.prototype, 'insertIfAbsent', function (this: WakeQueueStore, item: Parameters<typeof insert>[0]) {
    if (item.kind === 'background_interrupted' && ++attempts === 1 && failedPublish) throw new Error('Synthetic recovery queue unavailable');
    return insert.call(this, item);
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const runtime = { kind: 'synthetic',
    async run(input: AgentRuntimeInput) {
      runs++;
      assert.match(input.prompt, /background.*interrupt/i);
      await gate;
      if (stop) {
        await assert.rejects(service.respond(sessionId, 'response', 'Late after Stop', input.itemId), /No accepted input/);
        refused = true;
      } else {
        await service.attach(sessionId, 'https://github.com/example/repo/pull/1', input.itemId);
        await service.respond(sessionId, 'response', 'Recovered and finished', input.itemId);
        await service.respond(sessionId, 'response', 'Recovered and finished', input.itemId);
      }
      return { text: 'Synthetic recovery complete' };
    },
    async appendToActiveRun() { return { accepted: false }; }, async close() { finish(); },
  };
  const host = new RuntimeHost({}, { animaHome: home, healthStore, logger: { log() {}, error() {} },
    loadAgents: async () => [await agentStore.read()], validateAgent: async () => {},
    memoryCoherenceScheduler: { async reconcile() {} },
    startAgent: async (agent, animaHome, options) => startRunningAgent({ agentId: agent.id, animaHome,
      agentRuntime: runtime, homePath: agent.homePath!, stateDir: home, runtimeEnv: {}, runLimiter: options.runLimiter }),
  });
  try {
    await host.reconcileOnce();
    if (failedPublish) {
      assert.deepEqual(host.runningAgentIds(), [], 'Do not start an idle worker before its durable recovery wake is queued');
      assert.equal(runs, 0); assert.equal(fake.posts.length, 1);
      await host.reconcileOnce();
    }
    await waitFor(() => runs === 1);
    assert.notEqual((await store.read()).receipts[original.id]!.answered, true);
    assert.equal(fake.posts.filter((p) => p.content.type === 'error').length, 0);
    if (stop) await service.receive(prompted(sessionId, true), install);
    finish();
    await waitFor(async () => (await queue.list()).length === 0);
    await host.reconcileOnce();
    assert.equal(runs, 1);
    assert.equal(fake.posts.filter((p) => p.content.type === 'response').length, stop ? 0 : 1);
    assert.equal(fake.links.length, stop ? 0 : 1); assert.equal(refused, stop);
    assert.equal(fake.posts.filter((p) => /ended without a confirmed/.test(p.content.body)).length, 0);
  } finally { finish(); await host.stop(); await (host as unknown as { linear: { observationWrite?: Promise<void> } }).linear.observationWrite; }
}));

test('runtime host supplies active, queued and native background work to the Linear status timer', async (t) => withTempAnimaHome(async (home) => {
  const { service, fake, agentStore, store } = await seedLinear(home);
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const queue = new WakeQueueService('scout');
  await service.receive(created(), install); const item = (await queue.list())[0]!;
  await service.markStarted(item, item.id); await queue.complete(item.id); await service.markSettled(item);
  const socket = createServer(); await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  await new ServerConfigStore().update((c) => ({ ...c, linearWebhook: { host: '127.0.0.1', port } }));
  let state: 'background' | 'active' | 'queued' | 'idle' = 'background';
  const host = new RuntimeHost({}, { animaHome: home, logger: { log() {}, error() {} },
    loadAgents: async () => [await agentStore.read()], validateAgent: async () => {},
    memoryCoherenceScheduler: { async reconcile() {} },
    startAgent: async () => ({ hasPendingItems: async () => state === 'queued', isActive: () => state === 'active',
      isProviderQuiescent: () => state !== 'background', async stop() {} }),
  });
  try {
    await host.reconcileOnce();
    for (const next of ['background', 'active', 'queued'] as const) {
      state = next; const count = fake.posts.length;
      const old = new Date(Date.now() - 11 * 60_000).toISOString();
      await store.update((f) => ({ ...f, receipts: { ...f.receipts, [item.id]: { ...f.receipts[item.id]!, acknowledgement: 'accepted', lastActivityAt: old, lastStatusAttemptAt: old } } }));
      await waitFor(() => fake.posts.length > count, { timeoutMs: 3000 });
      assert.equal(fake.posts.length, count + 1);
      assert.match(fake.posts.at(-1)!.content.body, /agent still has ongoing work/);
    }
    state = 'idle'; await service.respond(sessionId, 'response', 'Done', 'later-turn');
    const count = fake.posts.length;
    await host.reconcileOnce(); await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(fake.posts.length, count);
  } finally { await host.stop(); await (host as unknown as { linear: { observationWrite?: Promise<void> } }).linear.observationWrite; }
}));
