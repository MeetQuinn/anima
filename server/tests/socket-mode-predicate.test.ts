// Pins the reconnect predicate + shutdown semantics for ResilientSocketModeReceiver.
// Written against INTENDED behavior (see #458 gate): retry every transient class,
// fail closed ONLY on unrecoverable auth/config errors, and make the terminal state loud.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ResilientSocketModeReceiver } from '../slack/resilient-socket-mode-receiver.js';

type Rejection = { label: string; make: () => unknown; retry: boolean };

const coded = (code: string, dataError?: string) => () => {
  const err = new Error(`simulated ${code}${dataError ? `/${dataError}` : ''}`) as Error & {
    code: string;
    data?: { error: string };
  };
  err.code = code;
  if (dataError) err.data = { error: dataError };
  return err;
};

const CASES: Rejection[] = [
  { label: 'undefined (ws close, no error)', make: () => undefined, retry: true },
  { label: 'null', make: () => null, retry: true },
  { label: 'RateLimitedError', make: coded('slack_webapi_rate_limited_error'), retry: true },
  { label: 'RequestError (network)', make: coded('slack_webapi_request_error'), retry: true },
  { label: 'HTTPError (5xx)', make: coded('slack_webapi_http_error'), retry: true },
  { label: 'PlatformError (transient)', make: coded('slack_webapi_platform_error', 'internal_error'), retry: true },
  { label: 'PlatformError invalid_auth', make: coded('slack_webapi_platform_error', 'invalid_auth'), retry: false },
  { label: 'PlatformError account_inactive', make: coded('slack_webapi_platform_error', 'account_inactive'), retry: false },
];

async function probe(make: () => unknown) {
  const errors: string[] = [];
  const receiver = new ResilientSocketModeReceiver({
    appToken: 'xapp-test',
    reconnectDelayMs: 2,
    reconnectMaxDelayMs: 2,
    runtimeLogger: { log() {}, warn() {}, error: (m: string) => errors.push(m) },
  });
  (receiver.client as { disconnect: () => Promise<void> }).disconnect = async () => {};
  let attempts = 0;
  (receiver.client as { start: () => Promise<unknown> }).start = async () => {
    attempts += 1;
    if (attempts === 1) return { ok: true };
    throw make();
  };
  await receiver.start();
  receiver.client.emit('disconnected');
  await new Promise((r) => setTimeout(r, 120));
  const reconnectAttempts = attempts - 1;
  await receiver.stop().catch(() => {});
  return { errors, reconnectAttempts };
}

for (const testCase of CASES) {
  test(`reconnect predicate: ${testCase.label} -> ${testCase.retry ? 'retries' : 'fails closed'}`, async () => {
    const { errors, reconnectAttempts } = await probe(testCase.make);
    if (testCase.retry) {
      assert.ok(reconnectAttempts > 3, `expected sustained retries, saw ${reconnectAttempts}`);
    } else {
      assert.equal(reconnectAttempts, 1, `expected exactly one attempt, saw ${reconnectAttempts}`);
      // Iris product requirement: the terminal state must be loud and observable.
      // Match the give-up log specifically. `errors.length > 0` is too weak:
      // reconnectAfterDisconnect's catch-all also logs at error level, so that
      // assertion stays green even if the give-up log is demoted to warn.
      assert.ok(
        errors.some((m) => /failed permanently/i.test(m)),
        `expected a "failed permanently" error log, saw: ${JSON.stringify(errors)}`,
      );
    }
  });
}

test('SDK auto-reconnect stays disabled (a ws close surfaces as disconnected)', async () => {
  const receiver = new ResilientSocketModeReceiver({
    appToken: 'xapp-test',
    runtimeLogger: { log() {}, warn() {}, error() {} },
  });
  let sawDisconnected = false;
  receiver.client.on('disconnected', () => { sawDisconnected = true; });
  receiver.client.emit('close');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sawDisconnected, true, 'close must emit disconnected, not trigger SDK auto-reconnect');
});

test('an undefined start() fulfillment is connected, not stopped', async () => {
  const receiver = new ResilientSocketModeReceiver({
    appToken: 'xapp-test',
    runtimeLogger: { log() {}, warn() {}, error() {} },
  });
  (receiver.client as { disconnect: () => Promise<void> }).disconnect = async () => {};
  (receiver.client as { start: () => Promise<unknown> }).start = async () => undefined;

  assert.equal(await receiver.start(), undefined);
  await receiver.stop();
});

test('stop() during an in-flight connect leaves no live socket', async () => {
  let disconnects = 0;
  const receiver = new ResilientSocketModeReceiver({
    appToken: 'xapp-test',
    reconnectDelayMs: 2,
    runtimeLogger: { log() {}, warn() {}, error() {} },
  });
  (receiver.client as { disconnect: () => Promise<void> }).disconnect = async () => { disconnects += 1; };
  let attempts = 0;
  let release!: () => void;
  (receiver.client as { start: () => Promise<unknown> }).start = async () => {
    attempts += 1;
    if (attempts === 1) return { ok: true };
    return new Promise((resolve) => { release = () => resolve({ ok: true }); });
  };
  await receiver.start();
  receiver.client.emit('disconnected');
  await new Promise((r) => setTimeout(r, 10));
  const stopping = receiver.stop();
  await new Promise((r) => setTimeout(r, 10));
  const before = disconnects;
  release();
  await stopping;
  assert.ok(disconnects > before, 'a connection that lands after stop() must be torn down');
});

// --- backoff distribution (Iris: an unpinned behavior is a droppable behavior) ---
// Observed through the retry warn log, so these pin behavior, not a private field.
async function delaysFor(random: () => number, windowMs = 220): Promise<number[]> {
  const delays: number[] = [];
  const receiver = new ResilientSocketModeReceiver({
    appToken: 'xapp-test',
    reconnectDelayMs: 10,
    reconnectMaxDelayMs: 10_000,
    random,
    runtimeLogger: {
      log() {},
      error() {},
      warn: (m: string) => {
        const hit = /retrying in (\d+)ms/.exec(m);
        if (hit) delays.push(Number(hit[1]));
      },
    },
  });
  (receiver.client as { disconnect: () => Promise<void> }).disconnect = async () => {};
  let attempts = 0;
  (receiver.client as { start: () => Promise<unknown> }).start = async () => {
    attempts += 1;
    if (attempts === 1) return { ok: true };
    throw new Error('transient');
  };
  await receiver.start();
  receiver.client.emit('disconnected');
  await new Promise((r) => setTimeout(r, windowMs));
  await receiver.stop().catch(() => {});
  return delays;
}

test('backoff grows exponentially and never exceeds the cap', async () => {
  const delays = await delaysFor(() => 0.5);
  assert.ok(delays.length >= 3, `need >=3 delays to see growth, saw ${delays.length}`);
  for (let i = 1; i < delays.length; i += 1) {
    const prev = delays[i - 1] as number;
    const cur = delays[i] as number;
    assert.ok(cur > prev, `delay ${i} (${cur}ms) must exceed delay ${i - 1} (${prev}ms): ${delays.join(',')}`);
  }
  for (const d of delays) assert.ok(d <= 10_000, `delay ${d}ms exceeded the cap`);
});

test('backoff is jittered: two agents do not reconnect in lockstep', async () => {
  const [low, high] = await Promise.all([delaysFor(() => 0), delaysFor(() => 1)]);
  const n = Math.min(low.length, high.length);
  assert.ok(n >= 2, 'need >=2 comparable delays');
  const identical = low.slice(0, n).every((d, i) => d === high[i]);
  assert.equal(identical, false, `un-jittered: both agents produced ${low.slice(0, n).join(',')}`);
  for (let i = 0; i < n; i += 1) {
    assert.ok((low[i] as number) <= (high[i] as number), 'jitter must be monotone in random()');
  }
});

test('a fatal error during initial start() is loud and rejects', async () => {
  const errors: string[] = [];
  const receiver = new ResilientSocketModeReceiver({
    appToken: 'xapp-test',
    reconnectDelayMs: 2,
    runtimeLogger: { log() {}, warn() {}, error: (m: string) => errors.push(m) },
  });
  (receiver.client as { disconnect: () => Promise<void> }).disconnect = async () => {};
  let attempts = 0;
  (receiver.client as { start: () => Promise<unknown> }).start = async () => {
    attempts += 1;
    throw coded('slack_webapi_platform_error', 'invalid_auth')();
  };
  await assert.rejects(() => receiver.start(), /invalid_auth/);
  assert.equal(attempts, 1, 'a fatal auth error must not be retried');
  assert.ok(
    errors.some((m) => /failed permanently/i.test(m)),
    `startup give-up must be loud, saw: ${JSON.stringify(errors)}`,
  );
});
