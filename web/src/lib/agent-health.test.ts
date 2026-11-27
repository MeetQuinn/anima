import { describe, expect, it } from 'vitest';

import { agentHealthProviderAction, agentHealthReasonText } from './agent-health';

describe('agent-health copy and actions', () => {
  it('words provider auth, quota, and rate-limit errors accurately', () => {
    expect(agentHealthReasonText('provider_auth_failed')).toBe(
      "This agent can't authenticate with its provider. Sign in again or update its credentials on this machine (Codex can sign in from Settings → Providers).",
    );
    expect(agentHealthReasonText('provider_quota_exhausted')).toBe(
      "This agent's provider quota is used up, so it couldn't finish its last turn. Check your plan or credits with the provider.",
    );
    expect(agentHealthReasonText('provider_rate_limited')).toBe(
      "This agent's provider is rate-limiting it. If this keeps happening, check your plan's rate limits.",
    );
  });

  it('routes auth-failed actions by whether the provider supports dashboard sign-in', () => {
    const health = {
      state: 'unhealthy' as const,
      reason: 'provider_auth_failed' as const,
      updatedAt: '2026-11-27T00:00:00.000Z',
    };
    expect(agentHealthProviderAction(health, 'codex-cli')).toEqual({
      description: "Provider sign-in or credentials aren't working.",
      kind: 'providers',
      label: 'Open Providers',
    });
    expect(agentHealthProviderAction(health, 'claude-code')).toEqual({
      description: "Provider sign-in or credentials aren't working.",
      kind: 'profile',
      label: 'Check runtime settings',
    });
    expect(agentHealthProviderAction(health)).toEqual({
      description: "Provider sign-in or credentials aren't working.",
      kind: 'profile',
      label: 'Check runtime settings',
    });
  });
});
