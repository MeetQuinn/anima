import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyProviderFailureReason,
  providerFailureHealthReason,
  providerFailureReasonFromError,
} from '../providers/provider-failure.js';

test('provider failure classifier maps auth quota and rate limit errors', () => {
  assert.equal(
    classifyProviderFailureReason({ message: 'Invalid API key', status: 401 }),
    'provider_auth_failed',
  );
  assert.equal(
    classifyProviderFailureReason({ message: 'Forbidden by provider', status: '403' }),
    'provider_auth_failed',
  );
  assert.equal(
    classifyProviderFailureReason({ message: 'subscription text should not beat status', status: 429 }),
    'provider_rate_limited',
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
    classifyProviderFailureReason({ message: 'The provider hit a rate limit' }),
    'provider_rate_limited',
  );
  assert.equal(
    classifyProviderFailureReason({ message: 'Something else broke' }),
    'provider_error',
  );
});

test('provider failure classifier avoids broad text-only false positives', () => {
  assert.equal(
    classifyProviderFailureReason({ message: 'login form loaded successfully' }),
    'provider_error',
  );
  assert.equal(
    classifyProviderFailureReason({ message: 'capacity planning report attached' }),
    'provider_error',
  );
  assert.equal(
    classifyProviderFailureReason({ message: 'subscription webhook delivered' }),
    'provider_error',
  );
  assert.equal(
    classifyProviderFailureReason({ message: 'request was throttled briefly' }),
    'provider_error',
  );
});

test('provider failure classifier preserves unknown provider reason codes', () => {
  const error = Object.assign(new Error('opaque provider failure'), { reason: 'api_status_418' });
  assert.equal(providerFailureReasonFromError(error), 'api_status_418');
  assert.equal(providerFailureHealthReason('api_status_418'), undefined);
  assert.equal(providerFailureHealthReason('provider_error'), 'provider_error');
});
