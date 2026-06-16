import test from 'node:test';
import assert from 'node:assert/strict';

import { QuiescentWaiterSet } from '../providers/quiescent-waiters.js';

test('quiescent waiter resolves immediately when already ready', async () => {
  const waiters = new QuiescentWaiterSet();

  await waiters.waitUntilReady(() => true);
});

test('quiescent waiter resolves when readiness flips', async () => {
  const waiters = new QuiescentWaiterSet();
  let ready = false;
  let resolved = false;

  const pending = waiters.waitUntilReady(() => ready).then(() => {
    resolved = true;
  });
  waiters.resolveIfReady(() => ready);
  await Promise.resolve();
  assert.equal(resolved, false);

  ready = true;
  waiters.resolveIfReady(() => ready);
  await pending;
  assert.equal(resolved, true);
});

test('quiescent waiter rejects on abort or shared rejection', async () => {
  const waiters = new QuiescentWaiterSet();
  const controller = new AbortController();
  const abortReason = new Error('stop waiting');

  const aborted = waiters.waitUntilReady(() => false, controller.signal);
  controller.abort(abortReason);
  await assert.rejects(aborted, abortReason);

  const failure = new Error('provider exited');
  const rejected = waiters.waitUntilReady(() => false);
  waiters.reject(failure);
  await assert.rejects(rejected, failure);
});
