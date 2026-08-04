import assert from 'node:assert/strict';
import test from 'node:test';

import {
  effectiveProviderRuntimeCommand,
  providerRuntimeCommandsResponse,
  type ProviderRuntimeCommandsConfig,
} from '../../shared/provider-runtime-commands.js';
import {
  ProviderRuntimeCommandError,
  ProviderRuntimeCommandService,
} from '../providers/runtime-command.service.js';

test('provider runtime commands expose catalog defaults without persisting overrides', () => {
  const response = providerRuntimeCommandsResponse({});
  assert.deepEqual(
    response.providers.map(({ command, defaultCommand, provider }) => ({
      command,
      defaultCommand,
      provider,
    })),
    [
      { command: null, defaultCommand: 'claude', provider: 'claude-code' },
      { command: null, defaultCommand: 'codex', provider: 'codex-cli' },
      { command: null, defaultCommand: 'kimi', provider: 'kimi-cli' },
      { command: null, defaultCommand: 'grok', provider: 'grok-cli' },
      { command: null, defaultCommand: 'opencode', provider: 'opencode-cli' },
    ],
  );
  assert.equal(effectiveProviderRuntimeCommand('codex-cli', {}), 'codex');
  assert.equal(
    effectiveProviderRuntimeCommand('codex-cli', { 'codex-cli': 'mcodex' }),
    'mcodex',
  );
});

test('provider runtime command save validates the executable and reset removes the override', async () => {
  let commands: ProviderRuntimeCommandsConfig = {};
  const writes: Array<{ command: string | null; provider: string }> = [];
  const service = new ProviderRuntimeCommandService({
    env: {},
    settings: {
      getProviderRuntimeCommands: async () => commands,
      setProviderRuntimeCommand: async (provider, command) => {
        writes.push({ command, provider });
        commands = { ...commands };
        if (command === null) delete commands[provider];
        else commands[provider] = command;
        return commands;
      },
    },
  });

  const saved = await service.set({
    command: process.execPath,
    provider: 'codex-cli',
  });
  assert.equal(
    saved.providers.find((row) => row.provider === 'codex-cli')?.command,
    process.execPath,
  );
  assert.deepEqual(writes, [
    { command: process.execPath, provider: 'codex-cli' },
  ]);

  const reset = await service.set({ command: null, provider: 'codex-cli' });
  assert.equal(
    reset.providers.find((row) => row.provider === 'codex-cli')?.command,
    null,
  );
  assert.deepEqual(commands, {});

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
  assert.equal(writes.length, 3, 'invalid commands must not be persisted');
});
