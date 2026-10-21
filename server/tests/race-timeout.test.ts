import assert from 'node:assert/strict';
import test from 'node:test';

import { raceWithTimeout } from '../race-timeout.js';

function pendingTimeouts(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}

test('raceWithTimeout returns the value and clears its timer when the promise wins', async () => {
  const before = pendingTimeouts();
  assert.equal(await raceWithTimeout(Promise.resolve('done'), 60_000, 'late'), 'done');
  assert.equal(pendingTimeouts(), before);

  await assert.rejects(raceWithTimeout(Promise.reject(new Error('boom')), 60_000, 'late'), /boom/);
  assert.equal(pendingTimeouts(), before);
});

test('raceWithTimeout returns the fallback when the promise is still pending', async () => {
  assert.equal(await raceWithTimeout(new Promise<string>(() => undefined), 5, 'late'), 'late');
});
