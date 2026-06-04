import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyProviderFailureReason,
  providerFailureHealthReason,
  providerFailureReasonFromError,
} from '../runtime/provider-failure.js';

test('provider failure classifier maps auth quota and rate limit errors', () => {
  assert.equal(
    classifyProviderFailureReason({ message: 'Invalid API key', status: 401 }),
    'provider_auth_failed',
  );
  assert.equal(
    classifyProviderFailureReason({ message: 'Usage limit reached for this plan' }),
    'provider_quota_exhausted',
  );
  assert.equal(
    classifyProviderFailureReason({ message: 'Too many requests', status: 429 }),
    'provider_rate_limited',
  );
  assert.equal(
    classifyProviderFailureReason({ message: 'Something else broke' }),
    'provider_error',
  );
});

test('provider failure classifier preserves unknown provider reason codes', () => {
  const error = Object.assign(new Error('opaque provider failure'), { reason: 'api_status_418' });
  assert.equal(providerFailureReasonFromError(error), 'api_status_418');
  assert.equal(providerFailureHealthReason('api_status_418'), undefined);
});
