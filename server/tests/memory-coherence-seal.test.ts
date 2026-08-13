import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { withAnimaHome } from './anima-home.js';
import {
  AgentRuntimeBridge,
  runtimeEnv,
} from '../runtime/runtime-bridge.js';
import {
  ANIMA_MEMORY_COHERENCE_HOME_ENV,
  ANIMA_MEMORY_COHERENCE_SEAL_ENV,
  assertMemoryCoherenceSealAllowsSideEffect,
  evaluateMemoryCoherenceWriteFence,
  isMemoryCoherenceAllowedWritePath,
  isMemoryCoherenceItem,
  MemoryCoherenceSealError,
} from '../runtime/memory-coherence-seal.js';
import {
  MEMORY_COHERENCE_WRITE_FENCE_HOOK_SOURCE,
  memoryCoherenceSealSettingsJson,
  writeMemoryCoherenceSealSettings,
} from '../runtime/memory-coherence-seal-settings.js';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { withToolActivity } from '../tools/tool-context.js';
import {
  ensureTestAgentConfig,
  makeMemoryCoherenceInboxItem,
  queueFor,
} from './helpers/runtime-worker.js';
import { makeSlackEvent as makeSlack } from './helpers/slack.js';
import { runtimeSessionServiceForAgent } from '../runtime/runtime-session.service.js';
import type { AgentRuntime } from '../providers/contract.js';
import type { RuntimeItemContext } from '../runtime/types.js';
import { claudeCommonArgs, CLAUDE_DISALLOWED_TOOLS } from '../providers/claude-launch.js';

test('isMemoryCoherenceItem keys only memory_coherence kind', () => {
  const memory = makeMemoryCoherenceInboxItem({
    scheduledSlotAt: '2026-08-12T05:47:00.000Z',
    timestamp: '2026-08-12T05:47:00.000Z',
  });
  assert.equal(isMemoryCoherenceItem(memory), true);
  assert.equal(
    isMemoryCoherenceItem(makeSlack({
      channelId: 'D1',
      teamId: 'T1',
      text: 'hi',
      userId: 'U1',
    })),
    false,
  );
});

test('runtimeEnv sets seal flag only for memory_coherence items', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-seal-env-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await ensureTestAgentConfig({ agentId: 'scout', stateDir });
      const memory = makeMemoryCoherenceInboxItem({
        scheduledSlotAt: '2026-08-12T05:47:00.000Z',
        timestamp: '2026-08-12T05:47:00.000Z',
      });
      const slack = makeSlack({
        channelId: 'D1',
        teamId: 'T1',
        text: 'hi',
        userId: 'U1',
      });
      const sealed = runtimeEnv({
        agentId: 'scout',
        homePath: join(stateDir, 'home'),
        item: memory,
        session: { createdAt: memory.receivedAt, currentStartedAt: memory.receivedAt, updatedAt: memory.receivedAt },
        stateDir,
      });
      assert.equal(sealed[ANIMA_MEMORY_COHERENCE_SEAL_ENV], '1');
      assert.equal(sealed.ANIMA_INBOX_ITEM_ID, memory.id);

      const open = runtimeEnv({
        agentId: 'scout',
        homePath: join(stateDir, 'home'),
        item: slack,
        session: { createdAt: slack.receivedAt, currentStartedAt: slack.receivedAt, updatedAt: slack.receivedAt },
        stateDir,
      });
      assert.equal(open[ANIMA_MEMORY_COHERENCE_SEAL_ENV], undefined);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('providerSessionFor never resumes a business session on memory_coherence', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-seal-session-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await ensureTestAgentConfig({ agentId: 'scout', stateDir });
      // Plant a long-lived primary Claude session (Grant shape).
      await runtimeSessionServiceForAgent('scout').upsertPrimarySession();
      await runtimeSessionServiceForAgent('scout').persistProviderSession('claude-code', {
        id: 'business-session-04d7',
        updatedAt: new Date().toISOString(),
      });
      const session = await runtimeSessionServiceForAgent('scout').upsertPrimarySession();
      assert.equal(session.current?.id, 'business-session-04d7');

      const memory = makeMemoryCoherenceInboxItem({
        scheduledSlotAt: '2026-08-12T05:47:00.000Z',
        timestamp: '2026-08-12T05:47:00.000Z',
      });
      await queueFor('scout').enqueue(memory);

      const runtime: AgentRuntime = {
        kind: 'claude-code',
        env: {},
        async run() {
          return { text: 'ok' };
        },
        async appendToActiveRun() {
          return { accepted: false };
        },
      };
      const bridge = new AgentRuntimeBridge(runtime);
      const context: RuntimeItemContext = {
        agentId: 'scout',
        homePath: join(stateDir, 'home'),
        item: memory,
        session,
        stateDir,
      };
      const input = await bridge.runInput({
        context,
        profile: { displayName: 'Scout', transports: { feishu: false, slack: true } },
        session,
      });
      // Isolated context: no resume of business-session-04d7.
      assert.equal(input.providerSession, undefined);
      assert.equal(input.env[ANIMA_MEMORY_COHERENCE_SEAL_ENV], '1');

      // Maintenance must not overwrite the primary business session id.
      await input.effects.persistProviderSession({
        id: 'maintenance-ephemeral',
        updatedAt: new Date().toISOString(),
      });
      const after = await runtimeSessionServiceForAgent('scout').upsertPrimarySession();
      assert.equal(after.current?.id, 'business-session-04d7');
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('side-effect tools fail closed under active memory-coherence seal (Grant external.effect path)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-seal-tool-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await ensureTestAgentConfig({ agentId: 'scout', stateDir });
      const memory = makeMemoryCoherenceInboxItem({
        scheduledSlotAt: '2026-08-12T05:47:00.000Z',
        timestamp: '2026-08-12T05:47:00.000Z',
      });
      await queueFor('scout').enqueue(memory);
      process.env.ANIMA_INBOX_ITEM_ID = memory.id;
      process.env.ANIMA_AGENT_ID = 'scout';
      process.env[ANIMA_MEMORY_COHERENCE_SEAL_ENV] = '1';

      await assert.rejects(
        () => assertMemoryCoherenceSealAllowsSideEffect('scout', 'slack.message.send'),
        (error: unknown) => error instanceof MemoryCoherenceSealError,
      );

      let opRan = false;
      await assert.rejects(
        () => withToolActivity({
          audit: { agentId: 'scout' },
          basePayload: { tool: 'message.send' },
          effectType: 'slack.message.send',
          op: async () => {
            opRan = true;
            return { result: undefined };
          },
        }),
        (error: unknown) => error instanceof MemoryCoherenceSealError,
      );
      assert.equal(opRan, false, 'sealed tool must not execute');
    });
  } finally {
    delete process.env.ANIMA_INBOX_ITEM_ID;
    delete process.env.ANIMA_AGENT_ID;
    delete process.env[ANIMA_MEMORY_COHERENCE_SEAL_ENV];
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('side-effect tools remain allowed on ordinary slack wakes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-seal-open-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await ensureTestAgentConfig({ agentId: 'scout', stateDir });
      const slack = makeSlack({
        channelId: 'D1',
        teamId: 'T1',
        text: 'hi',
        userId: 'U1',
      });
      await queueFor('scout').enqueue(slack);
      process.env.ANIMA_INBOX_ITEM_ID = slack.id;
      process.env.ANIMA_AGENT_ID = 'scout';
      delete process.env[ANIMA_MEMORY_COHERENCE_SEAL_ENV];

      await assertMemoryCoherenceSealAllowsSideEffect('scout', 'slack.message.send');
      let opRan = false;
      await withToolActivity({
        audit: { agentId: 'scout' },
        basePayload: { tool: 'message.send' },
        effectType: 'slack.message.send',
        op: async () => {
          opRan = true;
          return { result: undefined };
        },
      });
      assert.equal(opRan, true);
    });
  } finally {
    delete process.env.ANIMA_INBOX_ITEM_ID;
    delete process.env.ANIMA_AGENT_ID;
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('claude launch under seal disallows Bash/Task/web class tools', () => {
  const args = claudeCommonArgs({ kind: 'claude-code' }, undefined, {
    ANIMA_MEMORY_COHERENCE_SEAL: '1',
  });
  const list = args[args.indexOf('--disallowedTools') + 1] ?? '';
  assert.match(list, /Bash/);
  assert.match(list, /Task/);
  assert.match(list, /WebFetch/);
  for (const tool of CLAUDE_DISALLOWED_TOOLS) {
    assert.ok(list.includes(tool), `expected base disallow ${tool}`);
  }
});

test('write path allowlist: only MEMORY.md and notes/ under agent home', () => {
  const home = '/agents/grant';
  assert.equal(isMemoryCoherenceAllowedWritePath(home, 'MEMORY.md'), true);
  assert.equal(isMemoryCoherenceAllowedWritePath(home, `${home}/MEMORY.md`), true);
  assert.equal(isMemoryCoherenceAllowedWritePath(home, 'notes/archive.md'), true);
  assert.equal(isMemoryCoherenceAllowedWritePath(home, `${home}/notes/deep/a.md`), true);
  // Escape / other homes / repo root
  assert.equal(isMemoryCoherenceAllowedWritePath(home, 'notes/../secret.md'), false);
  assert.equal(isMemoryCoherenceAllowedWritePath(home, `${home}/notes/../../other/MEMORY.md`), false);
  assert.equal(isMemoryCoherenceAllowedWritePath(home, '/agents/other/MEMORY.md'), false);
  assert.equal(isMemoryCoherenceAllowedWritePath(home, '/tmp/deliverable.md'), false);
  assert.equal(isMemoryCoherenceAllowedWritePath(home, 'config.json'), false);
});

test('write fence evaluates Write/Edit tool payloads (allowlist deny-by-default)', () => {
  const home = '/agents/grant';
  assert.equal(
    evaluateMemoryCoherenceWriteFence({
      homePath: home,
      toolName: 'Write',
      toolInput: { file_path: `${home}/MEMORY.md` },
    }).allow,
    true,
  );
  assert.equal(
    evaluateMemoryCoherenceWriteFence({
      homePath: home,
      toolName: 'Edit',
      toolInput: { file_path: `${home}/notes/x.md` },
    }).allow,
    true,
  );
  const denied = evaluateMemoryCoherenceWriteFence({
    homePath: home,
    toolName: 'Write',
    toolInput: { file_path: '/agents/other/MEMORY.md' },
  });
  assert.equal(denied.allow, false);
  if (!denied.allow) assert.match(denied.reason, /write path denied/);

  // MultiEdit: any bad path fails the whole call.
  const multi = evaluateMemoryCoherenceWriteFence({
    homePath: home,
    toolName: 'MultiEdit',
    toolInput: {
      edits: [
        { file_path: `${home}/MEMORY.md` },
        { file_path: '/tmp/evil.md' },
      ],
    },
  });
  assert.equal(multi.allow, false);
});

test('PreToolUse write-fence hook rejects absolute path outside agent home', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-seal-hook-'));
  try {
    const hookPath = join(dir, 'hook.mjs');
    await writeFile(hookPath, MEMORY_COHERENCE_WRITE_FENCE_HOOK_SOURCE, 'utf8');
    const home = '/tmp/anima-seal-home-test';
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/outside-deliverable.md', content: 'x' },
    });
    const result = spawnSync(process.execPath, [hookPath], {
      env: { ...process.env, [ANIMA_MEMORY_COHERENCE_HOME_ENV]: home },
      input: payload,
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, `expected deny exit 2, got ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /write path denied/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('PreToolUse write-fence hook allows MEMORY.md under agent home', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-seal-hook-ok-'));
  try {
    const hookPath = join(dir, 'hook.mjs');
    await writeFile(hookPath, MEMORY_COHERENCE_WRITE_FENCE_HOOK_SOURCE, 'utf8');
    const home = '/tmp/anima-seal-home-test';
    const payload = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: `${home}/MEMORY.md`, old_string: 'a', new_string: 'b' },
    });
    const result = spawnSync(process.execPath, [hookPath], {
      env: { ...process.env, [ANIMA_MEMORY_COHERENCE_HOME_ENV]: home },
      input: payload,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `expected allow exit 0, got ${result.status}: ${result.stderr}`);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('claude sealed launch installs write-fence settings when path provided', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-seal-settings-'));
  try {
    const settingsPath = join(dir, 'settings.json');
    const written = await writeMemoryCoherenceSealSettings({
      homePath: '/agents/grant',
      settingsPath,
    });
    const args = claudeCommonArgs(
      { kind: 'claude-code' },
      undefined,
      { ANIMA_MEMORY_COHERENCE_SEAL: '1' },
      { sealSettingsPath: written.settingsPath },
    );
    assert.ok(args.includes('--settings'));
    assert.equal(args[args.indexOf('--settings') + 1], written.settingsPath);
    const settings = memoryCoherenceSealSettingsJson('/agents/grant', written.hookPath);
    assert.match(settings, /PreToolUse/);
    assert.match(settings, /Write\|Edit\|MultiEdit/);
    assert.match(settings, /memory-coherence-write-fence-hook/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('runtimeEnv carries agent home for write fence under seal', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-seal-home-env-'));
  try {
    await withAnimaHome(stateDir, async () => {
      await ensureTestAgentConfig({ agentId: 'scout', stateDir });
      const memory = makeMemoryCoherenceInboxItem({
        scheduledSlotAt: '2026-08-12T05:47:00.000Z',
        timestamp: '2026-08-12T05:47:00.000Z',
      });
      const homePath = join(stateDir, 'agent-home');
      const env = runtimeEnv({
        agentId: 'scout',
        homePath,
        item: memory,
        session: { createdAt: memory.receivedAt, currentStartedAt: memory.receivedAt, updatedAt: memory.receivedAt },
        stateDir,
      });
      assert.equal(env[ANIMA_MEMORY_COHERENCE_HOME_ENV], homePath);
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});
