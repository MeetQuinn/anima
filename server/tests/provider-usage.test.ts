import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderUsageService } from '../provider-usage/provider-usage.service.js';
import { providerUsageNetworkErrorMessage } from '../provider-usage/http.js';
import { parseClaudeUsageResponse } from '../provider-usage/providers/claude.js';
import { parseCodexUsageResponse } from '../provider-usage/providers/codex.js';
import { fetchKimiUsage, parseKimiUsageResponse } from '../provider-usage/providers/kimi.js';

test('Claude usage parser returns remaining windows and extra usage', () => {
  const parsed = parseClaudeUsageResponse({
    extra_usage: {
      currency: 'usd',
      is_enabled: true,
      monthly_limit: 4000,
      used_credits: 250,
    },
    five_hour: { resets_at: '2026-05-29T06:00:00.000Z', utilization: 7 },
    seven_day: { resets_at: '2026-06-01T00:00:00.000Z', utilization: 4 },
    seven_day_sonnet: { resets_at: '2026-06-01T00:00:00.000Z', utilization: 2 },
  }, { subscriptionType: 'max' });

  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.windows.map(({ label, remainingPercent }) => [label, remainingPercent]), [
    ['5h', 93],
    ['Weekly', 96],
    ['Weekly Sonnet', 98],
  ]);
  assert.deepEqual(parsed.extras, [
    { balance: 'Claude Max', label: 'Plan' },
    { currency: 'USD', label: 'Extra Usage', limit: 40, used: 2.5 },
  ]);
});

test('Codex usage parser returns rate-limit windows and credits', () => {
  const parsed = parseCodexUsageResponse({
    credits: { balance: '0', has_credits: false, unlimited: false },
    plan_type: 'pro',
    rate_limit: {
      primary_window: { limit_window_seconds: 18000, reset_after_seconds: 60, used_percent: 8 },
      secondary_window: { limit_window_seconds: 604800, reset_after_seconds: 120, used_percent: 56 },
    },
  });

  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.windows.map(({ label, remainingPercent, windowSeconds }) => [label, remainingPercent, windowSeconds]), [
    ['5h', 92, 18000],
    ['Weekly', 44, 604800],
  ]);
  assert.deepEqual(parsed.extras, [
    { balance: 'pro', label: 'Plan' },
    { balance: '0', label: 'Credits', unlimited: false },
  ]);
});

test('Kimi usage parser returns top-level and short-window limits', () => {
  const parsed = parseKimiUsageResponse({
    limits: [
      {
        detail: { limit: '100', remaining: '99', resetTime: '2026-05-29T08:00:00.000Z', used: '1' },
        window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' },
      },
    ],
    usage: { limit: 100, remaining: 99, resetTime: '2026-06-01T00:00:00.000Z', used: 1 },
  });

  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.windows.map(({ label, remainingPercent, usedPercent }) => [label, remainingPercent, usedPercent]), [
    ['5h', 99, 1],
    ['Weekly', 99, 1],
  ]);
});

test('Kimi usage reads Kimi Code credentials before legacy migrated credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anima-kimi-usage-home-'));
  await mkdir(join(home, '.kimi-code', 'credentials'), { recursive: true });
  await mkdir(join(home, '.kimi', 'credentials'), { recursive: true });
  await writeFile(
    join(home, '.kimi-code', 'credentials', 'kimi-code.json'),
    JSON.stringify({ access_token: 'new-kimi-code-token' }),
    'utf8',
  );
  await writeFile(
    join(home, '.kimi', 'credentials', 'kimi-code.json'),
    JSON.stringify({ access_token: 'legacy-expired-token' }),
    'utf8',
  );

  const originalHome = process.env.ANIMA_PROVIDER_USAGE_HOME;
  const originalShareDir = process.env.KIMI_SHARE_DIR;
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  process.env.ANIMA_PROVIDER_USAGE_HOME = home;
  delete process.env.KIMI_SHARE_DIR;
  globalThis.fetch = (async (_url, init) => {
    authorizations.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''));
    return new Response(JSON.stringify({ usage: { limit: 100, remaining: 75 }, limits: [] }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  }) as typeof fetch;

  try {
    const result = await fetchKimiUsage();
    assert.equal(result.status, 'available');
    assert.deepEqual(authorizations, ['Bearer new-kimi-code-token']);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('ANIMA_PROVIDER_USAGE_HOME', originalHome);
    restoreEnv('KIMI_SHARE_DIR', originalShareDir);
  }
});

test('provider usage network errors are classified without raw fetch wording', () => {
  const abortError = new Error('This operation was aborted');
  abortError.name = 'AbortError';

  const dnsError = new Error('fetch failed') as Error & { cause?: unknown };
  dnsError.cause = { code: 'ENOTFOUND' };

  assert.equal(providerUsageNetworkErrorMessage(abortError), 'Provider usage request timed out.');
  assert.equal(providerUsageNetworkErrorMessage(dnsError), 'Provider usage service could not be resolved.');
  assert.equal(
    providerUsageNetworkErrorMessage(new Error('fetch failed')),
    'Provider usage request could not reach the provider service.',
  );
});

test('provider usage service isolates adapter failures per provider', async () => {
  const service = new ProviderUsageService([
    {
      fetch: async () => ({ extras: [], status: 'available', windows: [{ label: '5h', remainingPercent: 92 }] }),
      label: 'Good',
      provider: 'codex-cli',
      source: 'private-api',
    },
    {
      fetch: async () => {
        throw new Error('private endpoint changed');
      },
      label: 'Bad',
      provider: 'claude-code',
      source: 'private-api',
    },
  ]);

  const response = await service.list();
  assert.equal(response.providers.length, 2);
  assert.equal(response.providers[0]?.status, 'available');
  assert.equal(response.providers[1]?.status, 'unavailable');
  assert.equal(response.providers[1]?.error?.type, 'unknown');
});

test('provider usage service can refresh a single provider without calling the others', async () => {
  let codexCalls = 0;
  let claudeCalls = 0;
  const service = new ProviderUsageService([
    {
      fetch: async () => {
        codexCalls += 1;
        return { extras: [], status: 'available', windows: [{ label: '5h', remainingPercent: 92 }] };
      },
      label: 'Codex',
      provider: 'codex-cli',
      source: 'private-api',
    },
    {
      fetch: async () => {
        claudeCalls += 1;
        return { extras: [], status: 'available', windows: [{ label: '5h', remainingPercent: 88 }] };
      },
      label: 'Claude',
      provider: 'claude-code',
      source: 'private-api',
    },
  ]);

  const row = await service.get('codex-cli');

  assert.equal(row.provider, 'codex-cli');
  assert.equal(row.status, 'available');
  assert.equal(codexCalls, 1);
  assert.equal(claudeCalls, 0);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
