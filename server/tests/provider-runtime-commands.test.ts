import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentProviderRuntimeArgs,
  agentProviderRuntimeCommand,
  effectiveProviderRuntimeArgs,
  effectiveProviderRuntimeCommand,
  providerRuntimeCommandsResponse,
  type ProviderRuntimeArgsConfig,
  type ProviderRuntimeCommandsConfig,
} from '../../shared/provider-runtime-commands.js';
import { ServerConfig } from '../storage/schema/server.store.js';
import {
  ProviderRuntimeCommandError,
  ProviderRuntimeCommandService,
} from '../providers/runtime-command.service.js';

test('provider runtime launch settings expose catalog defaults without persisting overrides', () => {
  const response = providerRuntimeCommandsResponse({});
  assert.deepEqual(
    response.providers.map(({ args, command, defaultCommand, provider }) => ({
      args,
      command,
      defaultCommand,
      provider,
    })),
    [
      { args: [], command: null, defaultCommand: 'claude', provider: 'claude-code' },
      { args: [], command: null, defaultCommand: 'codex', provider: 'codex-cli' },
      { args: [], command: null, defaultCommand: 'kimi', provider: 'kimi-cli' },
      { args: [], command: null, defaultCommand: 'grok', provider: 'grok-cli' },
      { args: [], command: null, defaultCommand: 'opencode', provider: 'opencode-cli' },
      { args: [], command: null, defaultCommand: 'pi', provider: 'pi' },
    ],
  );
  assert.equal(effectiveProviderRuntimeCommand('codex-cli', {}), 'codex');
  assert.equal(
    effectiveProviderRuntimeCommand('codex-cli', { 'codex-cli': 'mcodex' }),
    'mcodex',
  );
  assert.deepEqual(
    effectiveProviderRuntimeArgs('claude-code', {
      'claude-code': ['--chrome'],
    }),
    ['--chrome'],
  );
});

// Task #183: agent-level overrides sit ABOVE the machine-wide layer — set
// replaces wholesale (no concatenation), unset inherits machine-wide, which
// falls back to the catalog default. Command and args resolve independently.
test('agent-level runtime overrides replace machine-wide values wholesale, unset inherits', () => {
  const machineCommands: ProviderRuntimeCommandsConfig = { 'codex-cli': 'mcodex' };
  const machineArgs: ProviderRuntimeArgsConfig = { 'codex-cli': ['--machine-flag'] };

  // Set: agent value wins over both machine-wide and catalog.
  assert.equal(
    agentProviderRuntimeCommand(
      { kind: 'codex-cli', runtimeCommand: '/opt/agent-wrapper' },
      machineCommands,
    ),
    '/opt/agent-wrapper',
  );
  assert.deepEqual(
    agentProviderRuntimeArgs(
      { kind: 'codex-cli', runtimeArgs: ['--agent-flag'] },
      machineArgs,
    ),
    ['--agent-flag'],
  );

  // Unset: inherit the machine-wide value.
  assert.equal(agentProviderRuntimeCommand({ kind: 'codex-cli' }, machineCommands), 'mcodex');
  assert.deepEqual(agentProviderRuntimeArgs({ kind: 'codex-cli' }, machineArgs), ['--machine-flag']);

  // Unset everywhere: catalog default command, empty args.
  assert.equal(agentProviderRuntimeCommand({ kind: 'codex-cli' }, {}), 'codex');
  assert.deepEqual(agentProviderRuntimeArgs({ kind: 'codex-cli' }, {}), []);

  // Independence: an agent runtimeCommand alone does not shadow machine args
  // (and vice versa), and empty agent args are an OVERRIDE (suppress machine
  // args), not an unset.
  assert.deepEqual(
    agentProviderRuntimeArgs(
      { kind: 'codex-cli', runtimeCommand: '/opt/agent-wrapper' },
      machineArgs,
    ),
    ['--machine-flag'],
  );
  assert.equal(
    agentProviderRuntimeCommand({ kind: 'codex-cli', runtimeArgs: ['--agent-flag'] }, machineCommands),
    'mcodex',
  );
  assert.deepEqual(agentProviderRuntimeArgs({ kind: 'codex-cli', runtimeArgs: [] }, machineArgs), []);

  // Resolved args are a copy, not a live reference to the config.
  const overrides = { kind: 'codex-cli' as const, runtimeArgs: ['--agent-flag'] };
  const resolved = agentProviderRuntimeArgs(overrides, {});
  resolved.push('--mutated');
  assert.deepEqual(overrides.runtimeArgs, ['--agent-flag']);
});

test('provider runtime launch save validates the executable and persists exact argv entries', async () => {
  let commands: ProviderRuntimeCommandsConfig = {};
  let args: ProviderRuntimeArgsConfig = {};
  const writes: Array<{
    args?: string[];
    command: string | null;
    provider: string;
  }> = [];
  const service = new ProviderRuntimeCommandService({
    env: {},
    settings: {
      getProviderRuntimeArgs: async () => args,
      getProviderRuntimeCommands: async () => commands,
      setProviderRuntimeSettings: async (provider, command, nextArgs) => {
        writes.push({ args: nextArgs, command, provider });
        commands = { ...commands };
        if (command === null) delete commands[provider];
        else commands[provider] = command;
        args = { ...args };
        if (nextArgs !== undefined) {
          if (nextArgs.length === 0) delete args[provider];
          else args[provider] = [...nextArgs];
        }
        return { args, commands };
      },
    },
  });

  const saved = await service.set({
    args: ['--profile', 'team one'],
    command: process.execPath,
    provider: 'codex-cli',
  });
  assert.equal(
    saved.providers.find((row) => row.provider === 'codex-cli')?.command,
    process.execPath,
  );
  assert.deepEqual(
    saved.providers.find((row) => row.provider === 'codex-cli')?.args,
    ['--profile', 'team one'],
  );
  assert.deepEqual(writes, [
    {
      args: ['--profile', 'team one'],
      command: process.execPath,
      provider: 'codex-cli',
    },
  ]);

  const commandOnlySave = await service.set({
    command: process.execPath,
    provider: 'codex-cli',
  });
  assert.deepEqual(
    commandOnlySave.providers.find((row) => row.provider === 'codex-cli')
      ?.args,
    ['--profile', 'team one'],
    'older command-only clients must not erase configured argv',
  );

  const reset = await service.set({
    args: [],
    command: null,
    provider: 'codex-cli',
  });
  assert.equal(
    reset.providers.find((row) => row.provider === 'codex-cli')?.command,
    null,
  );
  assert.deepEqual(commands, {});
  assert.deepEqual(args, {});

  const explicitDefault = await service.set({
    command: 'codex',
    provider: 'codex-cli',
  });
  assert.equal(
    explicitDefault.providers.find((row) => row.provider === 'codex-cli')
      ?.command,
    null,
  );
  assert.equal(writes.at(-1)?.command, null);

  await assert.rejects(
    service.set({ command: './mcodex', provider: 'codex-cli' }),
    /Runtime command paths must be absolute/,
  );

  await assert.rejects(
    service.set({
      command: '/definitely/missing/anima-provider-command',
      provider: 'codex-cli',
    }),
    (error: unknown) =>
      error instanceof ProviderRuntimeCommandError && error.statusCode === 409,
  );
  assert.equal(writes.length, 4, 'invalid commands must not be persisted');
});

test('provider runtime args reject ambiguous or unbounded argv values at config parse', () => {
  assert.deepEqual(
    ServerConfig.parse({
      providerArgs: {
        'claude-code': ['--chrome', 'profile with spaces'],
      },
    }).providerArgs,
    { 'claude-code': ['--chrome', 'profile with spaces'] },
  );
  for (const invalid of ['', '   ', 'line\nbreak', 'nul\0byte']) {
    assert.throws(() =>
      ServerConfig.parse({ providerArgs: { 'claude-code': [invalid] } }),
    );
  }
  assert.throws(() =>
    ServerConfig.parse({
      providerArgs: { 'claude-code': Array.from({ length: 129 }, () => '--flag') },
    }),
  );
});

test('ServerConfig ignores leftover providerAccounts (stale key stripped, feature stays dead)', () => {
  const parsed = ServerConfig.parse({
    providerAccounts: {
      claudeCode: {
        accounts: [{ id: 'secondary', label: 'Secondary' }],
        activeAccountId: 'secondary',
      },
    },
    runtime: { maxConcurrentAgentRuns: 5 },
  });
  assert.deepEqual(parsed, { runtime: { maxConcurrentAgentRuns: 5 } });
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, 'providerAccounts'),
    false,
    'parsed config must not retain providerAccounts',
  );
  // Other unknown keys still fail under strict fields.
  assert.throws(() => ServerConfig.parse({ notARealKey: true }), /unrecognized key/i);
});
