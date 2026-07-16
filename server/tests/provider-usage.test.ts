import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderUsageService } from '../provider-usage/provider-usage.service.js';
import { providerUsageNetworkErrorMessage } from '../provider-usage/http.js';
import { fetchClaudeUsage, parseClaudeUsageResponse } from '../provider-usage/providers/claude.js';
import { fetchCodexUsage, parseCodexUsageResponse } from '../provider-usage/providers/codex.js';
import {
  fetchGrokUsage,
  fetchUntilBody,
  parseGrokBillingBytes,
  parseGrpcWebFrames,
} from '../provider-usage/providers/grok.js';
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
    // Legacy model-scoped fields are now always null upstream and must be ignored.
    seven_day_sonnet: { resets_at: '2026-06-01T00:00:00.000Z', utilization: 2 },
    seven_day_opus: null,
    // Model-scoped weekly quotas now arrive in the `limits` array under scope.model.
    limits: [
      { kind: 'session', percent: 7, resets_at: '2026-05-29T06:00:00.000Z', scope: null },
      { kind: 'weekly_all', percent: 4, resets_at: '2026-06-01T00:00:00.000Z', scope: null },
      {
        kind: 'weekly_scoped',
        percent: 51,
        resets_at: '2026-06-01T00:00:00.000Z',
        scope: { model: { id: null, display_name: 'Fable' } },
      },
    ],
  }, { subscriptionType: 'max' });

  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.windows.map(({ label, remainingPercent }) => [label, remainingPercent]), [
    ['5h', 93],
    ['Weekly', 96],
    ['Weekly Fable', 49],
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

test('Codex usage parser labels windows by duration, not slot position', () => {
  // When Codex retires a limit, the remaining window can arrive as
  // primary_window; the label must follow limit_window_seconds.
  const parsed = parseCodexUsageResponse({
    plan_type: 'pro',
    rate_limit: {
      primary_window: { limit_window_seconds: 604800, reset_after_seconds: 563640, used_percent: 15 },
    },
  });

  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.windows.map(({ label, windowSeconds }) => [label, windowSeconds]), [['Weekly', 604800]]);
});

test('Codex usage parser keeps positional labels when window duration is absent', () => {
  const parsed = parseCodexUsageResponse({
    plan_type: 'pro',
    rate_limit: {
      primary_window: { reset_after_seconds: 60, used_percent: 8 },
      secondary_window: { reset_after_seconds: 120, used_percent: 56 },
    },
  });

  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.windows.map(({ label }) => label), ['5h', 'Weekly']);
});

test('Codex usage parser keeps the Code Review feature label regardless of window duration', () => {
  // Code Review's label names the feature, not the window length: a weekly
  // duration must not relabel it via the duration-derivation path.
  const parsed = parseCodexUsageResponse({
    code_review_rate_limit: {
      primary_window: { limit_window_seconds: 604800, reset_after_seconds: 120, used_percent: 10 },
    },
    plan_type: 'pro',
    rate_limit: {
      primary_window: { limit_window_seconds: 18000, reset_after_seconds: 60, used_percent: 8 },
    },
  });

  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.windows.map(({ label, windowSeconds }) => [label, windowSeconds]), [
    ['5h', 18000],
    ['Code Review', 604800],
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
    user: { userId: 'kimi-user-1' },
  });

  assert.equal(parsed.error, undefined);
  assert.equal(parsed.account, 'kimi-user-1');
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
    return new Response(JSON.stringify({ usage: { limit: 100, remaining: 75 }, limits: [], user: { userId: 'kimi-user-2' } }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  }) as typeof fetch;

  try {
    const result = await fetchKimiUsage();
    assert.equal(result.status, 'available');
    assert.equal(result.account, 'kimi-user-2');
    assert.deepEqual(authorizations, ['Bearer new-kimi-code-token']);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('ANIMA_PROVIDER_USAGE_HOME', originalHome);
    restoreEnv('KIMI_SHARE_DIR', originalShareDir);
  }
});

test('Codex usage refreshes an expired access token before fetching usage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anima-codex-usage-home-'));
  await mkdir(join(home, '.codex'), { recursive: true });
  const authPath = join(home, '.codex', 'auth.json');
  await writeFile(
    authPath,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: jwtWithExp(Math.floor(Date.now() / 1000) - 60),
        id_token: jwtWithClaims({ email: 'old@example.com' }),
        refresh_token: 'old-codex-refresh',
      },
    }),
    'utf8',
  );

  const originalHome = process.env.ANIMA_PROVIDER_USAGE_HOME;
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  process.env.ANIMA_PROVIDER_USAGE_HOME = home;
  globalThis.fetch = (async (url, init) => {
    if (String(url) === 'https://auth.openai.com/oauth/token') {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: 'old-codex-refresh',
      });
      return jsonResponse({
        access_token: 'fresh-codex-access',
        id_token: jwtWithClaims({ email: 'fresh@example.com' }),
        refresh_token: 'fresh-codex-refresh',
      });
    }
    authorizations.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''));
    return jsonResponse(codexUsagePayload());
  }) as typeof fetch;

  try {
    const result = await fetchCodexUsage();
    assert.equal(result.status, 'available');
    assert.equal(result.account, 'fresh@example.com');
    assert.deepEqual(authorizations, ['Bearer fresh-codex-access']);
    const stored = JSON.parse(await readFile(authPath, 'utf8')) as { last_refresh?: string; tokens: Record<string, string> };
    assert.equal(stored.tokens.access_token, 'fresh-codex-access');
    assert.equal(stored.tokens.refresh_token, 'fresh-codex-refresh');
    assert.equal(stored.tokens.id_token, jwtWithClaims({ email: 'fresh@example.com' }));
    assert.ok(stored.last_refresh);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('ANIMA_PROVIDER_USAGE_HOME', originalHome);
  }
});

test('Kimi usage refreshes and retries once after a usage 401', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anima-kimi-refresh-home-'));
  await mkdir(join(home, '.kimi-code', 'credentials'), { recursive: true });
  await writeFile(join(home, '.kimi-code', 'device_id'), 'test-device-id', 'utf8');
  const credentialPath = join(home, '.kimi-code', 'credentials', 'kimi-code.json');
  await writeFile(
    credentialPath,
    JSON.stringify({
      access_token: 'stale-kimi-access',
      expires_at: Math.floor(Date.now() / 1000) + 600,
      refresh_token: 'old-kimi-refresh',
      scope: 'kimi-code',
      token_type: 'Bearer',
    }),
    'utf8',
  );

  const originalHome = process.env.ANIMA_PROVIDER_USAGE_HOME;
  const originalShareDir = process.env.KIMI_SHARE_DIR;
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  process.env.ANIMA_PROVIDER_USAGE_HOME = home;
  delete process.env.KIMI_SHARE_DIR;
  globalThis.fetch = (async (url, init) => {
    if (String(url) === 'https://auth.kimi.com/api/oauth/token') {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('client_id'), '17e5f671-d194-4dfb-9706-5516cb48c098');
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'old-kimi-refresh');
      assert.equal((init?.headers as Record<string, string>)['X-Msh-Device-Id'], 'test-device-id');
      return jsonResponse({
        access_token: 'fresh-kimi-access',
        expires_in: 900,
        refresh_token: 'fresh-kimi-refresh',
        scope: 'kimi-code',
        token_type: 'Bearer',
      });
    }
    authorizations.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''));
    if (authorizations.length === 1) return jsonResponse({ error: 'expired' }, 401);
    return jsonResponse({ usage: { limit: 100, remaining: 75 }, limits: [] });
  }) as typeof fetch;

  try {
    const result = await fetchKimiUsage();
    assert.equal(result.status, 'available');
    assert.deepEqual(authorizations, ['Bearer stale-kimi-access', 'Bearer fresh-kimi-access']);
    const stored = JSON.parse(await readFile(credentialPath, 'utf8')) as Record<string, unknown>;
    assert.equal(stored.access_token, 'fresh-kimi-access');
    assert.equal(stored.refresh_token, 'fresh-kimi-refresh');
    assert.equal(stored.expires_in, 900);
    assert.equal(typeof stored.expires_at, 'number');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('ANIMA_PROVIDER_USAGE_HOME', originalHome);
    restoreEnv('KIMI_SHARE_DIR', originalShareDir);
  }
});

test('Claude usage refreshes expired file credentials before fetching usage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anima-claude-refresh-home-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'claude@example.com' } }),
    'utf8',
  );
  const credentialPath = join(home, '.claude', '.credentials.json');
  await writeFile(
    credentialPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'expired-claude-access',
        expiresAt: Date.now() - 60_000,
        rateLimitTier: 'claude_max',
        refreshToken: 'old-claude-refresh',
        subscriptionType: 'max',
      },
    }),
    'utf8',
  );

  const originalHome = process.env.ANIMA_PROVIDER_USAGE_HOME;
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  process.env.ANIMA_PROVIDER_USAGE_HOME = home;
  globalThis.fetch = (async (url, init) => {
    if (String(url) === 'https://platform.claude.com/v1/oauth/token') {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
        grant_type: 'refresh_token',
        refresh_token: 'old-claude-refresh',
      });
      assert.equal((init?.headers as Record<string, string>)['anthropic-beta'], 'oauth-2025-04-20');
      return jsonResponse({
        access_token: 'fresh-claude-access',
        expires_in: 3600,
        refresh_token: 'fresh-claude-refresh',
        refresh_token_expires_in: 2_592_000,
      });
    }
    authorizations.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''));
    return jsonResponse({
      five_hour: { utilization: 7 },
      limits: [],
      seven_day: { utilization: 4 },
    });
  }) as typeof fetch;

  try {
    const result = await fetchClaudeUsage();
    assert.equal(result.status, 'available');
    assert.equal(result.account, 'claude@example.com');
    assert.deepEqual(authorizations, ['Bearer fresh-claude-access']);
    const stored = JSON.parse(await readFile(credentialPath, 'utf8')) as { claudeAiOauth: Record<string, unknown> };
    assert.equal(stored.claudeAiOauth.accessToken, 'fresh-claude-access');
    assert.equal(stored.claudeAiOauth.refreshToken, 'fresh-claude-refresh');
    assert.equal(typeof stored.claudeAiOauth.expiresAt, 'number');
    assert.equal(typeof stored.claudeAiOauth.refreshTokenExpiresAt, 'number');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('ANIMA_PROVIDER_USAGE_HOME', originalHome);
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

// Captured live response from GetGrokCreditsConfig (usedPercent=9), matching Raycast Agent Usage.
const GROK_BILLING_FIXTURE = Buffer.from(
  '00000000560a540d0000104112001a00220c08eebfcfd20610d8a4b890032a0c08eeb4f4d20610d8a4b890033a0708021500001041421e0802120c08eebfcfd20610d8a4b890031a0c08eeb4f4d20610d8a4b89003580162006801800000000f677270632d7374617475733a300d0a',
  'hex',
);

test('Grok billing parser extracts used percent from gRPC-Web protobuf', () => {
  const parsed = parseGrokBillingBytes(new Uint8Array(GROK_BILLING_FIXTURE), Date.parse('2026-07-16T03:00:00.000Z'));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.snapshot?.usedPercent, 9);
});

test('Grok usage reads ~/.grok/auth.json key and calls billing endpoint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anima-grok-usage-home-'));
  await mkdir(join(home, '.grok'), { recursive: true });
  const authPath = join(home, '.grok', 'auth.json');
  await writeFile(
    authPath,
    JSON.stringify({
      'https://auth.x.ai::test-client': {
        auth_mode: 'oidc',
        email: 'operator@example.com',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        key: 'grok-access-token',
        oidc_client_id: 'test-client',
        oidc_issuer: 'https://auth.x.ai',
        refresh_token: 'grok-refresh',
        team_id: 'team-1',
      },
    }),
    'utf8',
  );

  const originalHome = process.env.ANIMA_PROVIDER_USAGE_HOME;
  const originalGrokHome = process.env.GROK_HOME;
  const originalFetch = globalThis.fetch;
  const seen: Array<{ auth?: string; url: string }> = [];
  process.env.ANIMA_PROVIDER_USAGE_HOME = home;
  delete process.env.GROK_HOME;
  globalThis.fetch = (async (url, init) => {
    const href = String(url);
    seen.push({
      auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''),
      url: href,
    });
    if (href.includes('GetGrokCreditsConfig')) {
      return new Response(GROK_BILLING_FIXTURE, {
        headers: { 'content-type': 'application/grpc-web+proto' },
        status: 200,
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

  try {
    const result = await fetchGrokUsage();
    assert.equal(result.status, 'available');
    assert.equal(result.account, 'operator@example.com');
    assert.equal(result.windows[0]?.usedPercent, 9);
    assert.equal(result.windows[0]?.remainingPercent, 91);
    // Label is Weekly/Monthly/Credits based on reset distance; fixture resets are multi-day.
    assert.ok(result.windows[0]?.label === 'Weekly' || result.windows[0]?.label === 'Credits');
    assert.equal(seen.length, 1);
    assert.match(seen[0]?.url ?? '', /GetGrokCreditsConfig/);
    assert.equal(seen[0]?.auth, 'Bearer grok-access-token');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('ANIMA_PROVIDER_USAGE_HOME', originalHome);
    restoreEnv('GROK_HOME', originalGrokHome);
  }
});

test('Grok usage refreshes an expired access token before billing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anima-grok-refresh-home-'));
  await mkdir(join(home, '.grok'), { recursive: true });
  const authPath = join(home, '.grok', 'auth.json');
  const scope = 'https://auth.x.ai::test-client';
  await writeFile(
    authPath,
    JSON.stringify({
      [scope]: {
        auth_mode: 'oidc',
        email: 'operator@example.com',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        key: 'stale-grok-access',
        oidc_client_id: 'test-client',
        oidc_issuer: 'https://auth.x.ai',
        refresh_token: 'old-grok-refresh',
      },
    }),
    'utf8',
  );

  const originalHome = process.env.ANIMA_PROVIDER_USAGE_HOME;
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  process.env.ANIMA_PROVIDER_USAGE_HOME = home;
  globalThis.fetch = (async (url, init) => {
    const href = String(url);
    if (href.includes('openid-configuration')) {
      return jsonResponse({ token_endpoint: 'https://auth.x.ai/oauth/token' });
    }
    if (href === 'https://auth.x.ai/oauth/token') {
      const body = String(init?.body);
      assert.match(body, /grant_type=refresh_token/);
      assert.match(body, /refresh_token=old-grok-refresh/);
      assert.match(body, /client_id=test-client/);
      return jsonResponse({
        access_token: 'fresh-grok-access',
        expires_in: 3600,
        refresh_token: 'fresh-grok-refresh',
      });
    }
    if (href.includes('GetGrokCreditsConfig')) {
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''));
      return new Response(GROK_BILLING_FIXTURE, {
        headers: { 'content-type': 'application/grpc-web+proto' },
        status: 200,
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

  try {
    const result = await fetchGrokUsage();
    assert.equal(result.status, 'available');
    assert.deepEqual(authorizations, ['Bearer fresh-grok-access']);
    const stored = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, { key: string; refresh_token: string }>;
    assert.equal(stored[scope]?.key, 'fresh-grok-access');
    assert.equal(stored[scope]?.refresh_token, 'fresh-grok-refresh');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('ANIMA_PROVIDER_USAGE_HOME', originalHome);
  }
});

test('Grok usage reports not_configured without auth.json', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anima-grok-empty-home-'));
  const originalHome = process.env.ANIMA_PROVIDER_USAGE_HOME;
  process.env.ANIMA_PROVIDER_USAGE_HOME = home;
  try {
    const result = await fetchGrokUsage();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.error?.type, 'not_configured');
  } finally {
    restoreEnv('ANIMA_PROVIDER_USAGE_HOME', originalHome);
  }
});

test('Grok billing parser rejects body trailer grpc-status 16 before accepting data', () => {
  const unauth = withGrpcTrailerStatus(GROK_BILLING_FIXTURE, '16', 'unauthenticated');
  const frames = parseGrpcWebFrames(new Uint8Array(unauth));
  assert.equal(frames.trailers['grpc-status'], '16');
  assert.ok(frames.payload && frames.payload.length > 0);

  const parsed = parseGrokBillingBytes(new Uint8Array(unauth));
  assert.equal(parsed.snapshot, undefined);
  assert.equal(parsed.error?.type, 'unauthorized');
});

test('Grok usage refreshes and retries after body trailer grpc-status 16', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anima-grok-trailer-auth-'));
  await mkdir(join(home, '.grok'), { recursive: true });
  const authPath = join(home, '.grok', 'auth.json');
  const scope = 'https://auth.x.ai::test-client';
  await writeFile(
    authPath,
    JSON.stringify({
      [scope]: {
        auth_mode: 'oidc',
        email: 'operator@example.com',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        key: 'stale-access',
        oidc_client_id: 'test-client',
        oidc_issuer: 'https://auth.x.ai',
        refresh_token: 'trailer-refresh',
      },
    }),
    'utf8',
  );

  const originalHome = process.env.ANIMA_PROVIDER_USAGE_HOME;
  const originalFetch = globalThis.fetch;
  const authorizations: string[] = [];
  let billingCalls = 0;
  let refreshCalls = 0;
  process.env.ANIMA_PROVIDER_USAGE_HOME = home;
  globalThis.fetch = (async (url, init) => {
    const href = String(url);
    if (href.includes('openid-configuration')) {
      return jsonResponse({ token_endpoint: 'https://auth.x.ai/oauth/token' });
    }
    if (href === 'https://auth.x.ai/oauth/token') {
      refreshCalls += 1;
      return jsonResponse({
        access_token: 'refreshed-after-trailer',
        expires_in: 3600,
        refresh_token: 'trailer-refresh-2',
      });
    }
    if (href.includes('GetGrokCreditsConfig')) {
      billingCalls += 1;
      authorizations.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''));
      if (billingCalls === 1) {
        return new Response(new Uint8Array(withGrpcTrailerStatus(GROK_BILLING_FIXTURE, '16', 'unauthenticated')), {
          headers: { 'content-type': 'application/grpc-web+proto' },
          status: 200,
        });
      }
      return new Response(new Uint8Array(GROK_BILLING_FIXTURE), {
        headers: { 'content-type': 'application/grpc-web+proto' },
        status: 200,
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

  try {
    const result = await fetchGrokUsage();
    assert.equal(result.status, 'available');
    assert.equal(result.windows[0]?.usedPercent, 9);
    assert.equal(billingCalls, 2);
    assert.equal(refreshCalls, 1);
    assert.deepEqual(authorizations, ['Bearer stale-access', 'Bearer refreshed-after-trailer']);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('ANIMA_PROVIDER_USAGE_HOME', originalHome);
  }
});

test('Grok billing parser is fail-closed on unrelated fixed32 and accepts omitted 0%', () => {
  for (const field of [1, 2, 15]) {
    const raw = encodeFixed32Field(field, 42);
    const framed = grpcWebMessageAndOkTrailer(raw);
    const parsed = parseGrokBillingBytes(framed);
    assert.equal(parsed.snapshot, undefined, `field ${field} float 42 must not be usage`);
    assert.equal(parsed.error?.type, 'parse_error');
  }

  const nowMs = Date.parse('2026-07-16T03:00:00.000Z');
  const futureResetSec = 1_800_000_000; // 2027-01-15 — future relative to nowMs
  const pastResetSec = 1_700_000_000; // 2023-11 — stale

  // future reset + weekly period 2 → 0%
  const weeklyZero = encodeLengthDelimited(
    1,
    Buffer.concat([
      encodeLengthDelimited(5, encodeVarintField(1, futureResetSec)),
      encodeLengthDelimited(8, encodeVarintField(1, 2)),
    ]),
  );
  const weeklyParsed = parseGrokBillingBytes(grpcWebMessageAndOkTrailer(weeklyZero), nowMs);
  assert.equal(weeklyParsed.error, undefined);
  assert.equal(weeklyParsed.snapshot?.usedPercent, 0);
  assert.equal(weeklyParsed.snapshot?.resetsAt, new Date(futureResetSec * 1000).toISOString());

  // future reset + monthly period 1 → also 0% (Raycast treats 1 and 2 as valid periods)
  const monthlyZero = encodeLengthDelimited(
    1,
    Buffer.concat([
      encodeLengthDelimited(5, encodeVarintField(1, futureResetSec)),
      encodeLengthDelimited(8, encodeVarintField(1, 1)),
    ]),
  );
  const monthlyParsed = parseGrokBillingBytes(grpcWebMessageAndOkTrailer(monthlyZero), nowMs);
  assert.equal(monthlyParsed.error, undefined);
  assert.equal(monthlyParsed.snapshot?.usedPercent, 0);

  // past/stale reset + weekly period must not invent 0%
  const staleZero = encodeLengthDelimited(
    1,
    Buffer.concat([
      encodeLengthDelimited(5, encodeVarintField(1, pastResetSec)),
      encodeLengthDelimited(8, encodeVarintField(1, 2)),
    ]),
  );
  const staleParsed = parseGrokBillingBytes(grpcWebMessageAndOkTrailer(staleZero), nowMs);
  assert.equal(staleParsed.snapshot, undefined);
  assert.equal(staleParsed.error?.type, 'parse_error');
});

test('Grok billing parser rejects truncated gRPC-Web trailer frames', () => {
  const frames = parseGrpcWebFrames(new Uint8Array(GROK_BILLING_FIXTURE));
  assert.ok(frames.payload);
  // Live 9% data frame + truncated trailer (declared length 20, only 4 bytes present).
  const truncated = Buffer.concat([
    grpcWebFrame(0, Buffer.from(frames.payload)),
    Buffer.from([0x80, 0x00, 0x00, 0x00, 0x14, 0x67, 0x72, 0x70, 0x63]), // "grpc"
  ]);
  const parsed = parseGrokBillingBytes(new Uint8Array(truncated));
  assert.equal(parsed.snapshot, undefined);
  assert.equal(parsed.error?.type, 'parse_error');
  assert.match(parsed.error?.message ?? '', /truncated/i);
});

test('Grok fetchUntilBody times out when response body stalls after headers', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream({
      start() {
        /* never enqueue or close */
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'application/grpc-web+proto' },
      status: 200,
    });
  }) as typeof fetch;

  try {
    const started = Date.now();
    await assert.rejects(
      () => fetchUntilBody('https://example.test/stall', { method: 'POST' }, 40),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `expected timeout well under 2s, got ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function withGrpcTrailerStatus(fixture: Buffer, status: string, message?: string): Buffer {
  const frames = parseGrpcWebFrames(new Uint8Array(fixture));
  assert.ok(frames.payload, 'fixture must include a data frame');
  const trailerLines = [`grpc-status:${status}`];
  if (message) trailerLines.push(`grpc-message:${message}`);
  trailerLines.push('');
  const trailer = Buffer.from(`${trailerLines.join('\r\n')}\r\n`, 'utf8');
  return Buffer.concat([grpcWebFrame(0, Buffer.from(frames.payload)), grpcWebFrame(0x80, trailer)]);
}

function grpcWebMessageAndOkTrailer(message: Buffer): Uint8Array {
  const trailer = Buffer.from('grpc-status:0\r\n', 'utf8');
  return new Uint8Array(Buffer.concat([grpcWebFrame(0, message), grpcWebFrame(0x80, trailer)]));
}

function grpcWebFrame(flags: number, data: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeVarintField(field: number, value: number): Buffer {
  const key = (field << 3) | 0;
  return Buffer.concat([encodeVarint(key), encodeVarint(value)]);
}

function encodeFixed32Field(field: number, floatValue: number): Buffer {
  const key = (field << 3) | 5;
  const body = Buffer.alloc(4);
  body.writeFloatLE(floatValue, 0);
  return Buffer.concat([encodeVarint(key), body]);
}

function encodeLengthDelimited(field: number, value: Buffer): Buffer {
  const key = (field << 3) | 2;
  return Buffer.concat([encodeVarint(key), encodeVarint(value.length), value]);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function codexUsagePayload(): unknown {
  return {
    credits: { balance: '0', has_credits: false, unlimited: false },
    plan_type: 'pro',
    rate_limit: {
      primary_window: { limit_window_seconds: 18000, reset_after_seconds: 60, used_percent: 8 },
      secondary_window: { limit_window_seconds: 604800, reset_after_seconds: 120, used_percent: 56 },
    },
  };
}

function jwtWithExp(exp: number): string {
  return jwtWithClaims({ exp });
}

function jwtWithClaims(claims: Record<string, unknown>): string {
  return [
    base64UrlJson({ alg: 'none', typ: 'JWT' }),
    base64UrlJson(claims),
    'signature',
  ].join('.');
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
