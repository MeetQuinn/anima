import test from 'node:test';
import assert from 'node:assert/strict';

import { ActiveRuntimeRun } from '../providers/active-runtime.js';

test('active runtime abort catches async abort cleanup failures', async () => {
  const activeRun = new ActiveRuntimeRun();
  const controller = new AbortController();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => {
    errors.push(String(message));
  };
  try {
    activeRun.start(
      {
        cwd: '/tmp',
        effects: {} as never,
        env: {},
        itemId: 'item-1',
        prompt: 'hello',
        signal: controller.signal,
      },
      'Test Runtime',
      async () => {
        throw new Error('late abort cleanup failed');
      },
    );

    controller.abort('shutdown');
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(errors, ['Test Runtime runtime abort failed: late abort cleanup failed']);
  } finally {
    console.error = originalError;
  }
});
