import assert from 'node:assert/strict';
import test from 'node:test';

import { grokAcpLaunchArgs } from '../providers/grok.js';

test('grok launch passes --effort only for models that support reasoning effort', () => {
  assert.deepEqual(
    grokAcpLaunchArgs({ kind: 'grok-cli', model: 'grok-4.5', reasoningEffort: 'high' }),
    [
      '--no-auto-update',
      'agent',
      '--no-leader',
      '--always-approve',
      '-m',
      'grok-4.5',
      '--effort',
      'high',
      'stdio',
    ],
  );

  // Composer does not support effort — never stamp a silent no-op flag.
  assert.deepEqual(
    grokAcpLaunchArgs({
      kind: 'grok-cli',
      model: 'grok-composer-2.5-fast',
      reasoningEffort: 'low',
    }),
    [
      '--no-auto-update',
      'agent',
      '--no-leader',
      '--always-approve',
      '-m',
      'grok-composer-2.5-fast',
      'stdio',
    ],
  );
});
