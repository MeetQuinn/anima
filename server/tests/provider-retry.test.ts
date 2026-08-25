import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyProviderRetry,
  isProviderCrashError,
  providerRateLimitResumeAt,
} from '../providers/provider-retry.js';

class TaggedError extends Error {
  constructor(message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

test('provider retry classifier separates crash, transient, rate-limited, and terminal failures', () => {
  assert.equal(classifyProviderRetry(new Error('Codex app-server runtime exited before completing active requests')), 'crash');
  assert.equal(isProviderCrashError(new Error('Claude Code runtime terminated by SIGKILL')), true);

  assert.equal(classifyProviderRetry(new Error('API Error: 529 Overloaded. This is a server-side issue (api status 529)')), 'transient');
  assert.equal(classifyProviderRetry(new Error('API Error: The response stopped arriving. The response above may be incomplete.')), 'transient');
  assert.equal(classifyProviderRetry(new Error('API Error: Unable to connect to API: SSL certificate has expired')), 'transient');
  assert.equal(classifyProviderRetry(new Error('API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)')), 'transient');
  assert.equal(classifyProviderRetry(new Error('session/prompt: Internal error code=-32603 data=reqwest error stream: error sending request')), 'transient');
  assert.equal(
    classifyProviderRetry(new Error("API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations.")),
    'transient',
  );
  // An adapter-computed `retryable` flag wins even when the text is opaque.
  assert.equal(classifyProviderRetry(new TaggedError('opaque provider failure', { retryable: true })), 'transient');

  assert.equal(classifyProviderRetry(new TaggedError("You've hit your session limit · resets 2:10pm (Asia/Shanghai)", { status: 429 })), 'rate_limited');
  assert.equal(classifyProviderRetry(new Error("You've hit your session limit · resets 2:10pm (Asia/Shanghai) (api status 429)")), 'rate_limited');
  assert.equal(classifyProviderRetry(new Error('Usage limit reached for this plan')), 'rate_limited');

  assert.equal(classifyProviderRetry(new Error('Failed to authenticate. API Error: 403 Request not allowed (api status 403)')), 'terminal');
  assert.equal(classifyProviderRetry(new Error('Invalid API key')), 'terminal');
  assert.equal(classifyProviderRetry(new Error('Malformed request body')), 'terminal');
});

test('provider rate-limit resume time follows the provider reset hint and stays bounded', () => {
  const now = new Date('2026-08-25T04:00:00.000Z'); // 12:00 Asia/Shanghai
  const shanghai = providerRateLimitResumeAt(
    new Error("You've hit your session limit · resets 2:10pm (Asia/Shanghai) (api status 429)"),
    now,
  );
  assert.equal(shanghai.toISOString(), '2026-08-25T06:10:00.000Z');

  // A wall-clock reset earlier than now means tomorrow; that lands on the 6h ceiling.
  const tomorrow = providerRateLimitResumeAt(new Error('rate limited · resets 11:30am (Asia/Shanghai)'), now);
  assert.equal(tomorrow.toISOString(), '2026-08-25T10:00:00.000Z');
  const laterToday = providerRateLimitResumeAt(new Error('rate limited · resets 3:45pm (Asia/Shanghai)'), now);
  assert.equal(laterToday.toISOString(), '2026-08-25T07:45:00.000Z');

  const relative = providerRateLimitResumeAt(new Error('Too many requests, try again in 90 seconds'), now);
  assert.equal(relative.toISOString(), '2026-08-25T04:01:30.000Z');

  const explicit = providerRateLimitResumeAt(new TaggedError('rate limited', { resetsAt: '2026-08-25T04:20:00.000Z' }), now);
  assert.equal(explicit.toISOString(), '2026-08-25T04:20:00.000Z');

  const fallback = providerRateLimitResumeAt(new Error('Too many requests'), now);
  assert.equal(fallback.toISOString(), '2026-08-25T04:05:00.000Z');

  // Never wait less than 30s (a "resets in 1 second" hint would hot-loop) nor more than 6h.
  const floor = providerRateLimitResumeAt(new Error('try again in 1 second'), now);
  assert.equal(floor.toISOString(), '2026-08-25T04:00:30.000Z');
  const ceiling = providerRateLimitResumeAt(new Error('resets in 30 hours'), now);
  assert.equal(ceiling.toISOString(), '2026-08-25T10:00:00.000Z');
});
