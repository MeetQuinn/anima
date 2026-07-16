import assert from 'node:assert/strict';
import test from 'node:test';

import { grokAcpLaunchArgs } from '../providers/grok.js';

test('grok launch never passes --effort (effort is applied via session/set_model)', () => {
  const base = ['--no-auto-update', 'agent', '--no-leader', '--always-approve'];

  // Even a configured, seemingly-supported effort is not a launch flag: the ACP
  // catalog is the authority, applied after session init via session/set_model.
  assert.deepEqual(
    grokAcpLaunchArgs({ kind: 'grok-cli', model: 'grok-4.5', reasoningEffort: 'high' }),
    [...base, '-m', 'grok-4.5', 'stdio'],
  );

  assert.deepEqual(
    grokAcpLaunchArgs({ kind: 'grok-cli', model: 'grok-composer-2.5-fast', reasoningEffort: 'low' }),
    [...base, '-m', 'grok-composer-2.5-fast', 'stdio'],
  );

  // No model configured → no -m, still no --effort.
  assert.deepEqual(grokAcpLaunchArgs({ kind: 'grok-cli' } as never), [...base, 'stdio']);

  for (const args of [
    grokAcpLaunchArgs({ kind: 'grok-cli', model: 'grok-4.5', reasoningEffort: 'high' }),
    grokAcpLaunchArgs({ kind: 'grok-cli', model: 'grok-composer-2.5-fast', reasoningEffort: 'low' }),
  ]) {
    assert.equal(args.includes('--effort'), false);
  }
});
