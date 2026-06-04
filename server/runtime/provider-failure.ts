import type { AgentHealthReason } from '../../shared/snapshot.js';
import { errorMessage } from '../ids.js';

export type ProviderFailureReason =
  | 'provider_auth_failed'
  | 'provider_error'
  | 'provider_quota_exhausted'
  | 'provider_rate_limited'
  | 'process_crash'
  | (string & {});

export function classifyProviderFailureReason(input: {
  message?: string;
  status?: unknown;
  subtype?: string;
}): ProviderFailureReason {
  const text = [input.message, input.subtype].filter(Boolean).join(' ');
  if (providerAuthFailed(input.status, text)) return 'provider_auth_failed';
  if (providerQuotaExhausted(text)) return 'provider_quota_exhausted';
  if (input.status === 429 || /\b(rate limit|rate-limit|rate_limit|too many requests|throttl)/i.test(text)) {
    return 'provider_rate_limited';
  }
  return 'provider_error';
}

export function providerFailureReasonFromError(error: unknown): ProviderFailureReason {
  const reason = stringProperty(error, 'reason');
  const status = unknownProperty(error, 'status');
  const subtype = stringProperty(error, 'subtype');
  const classified = classifyProviderFailureReason({
    message: errorMessage(error),
    ...(status !== undefined ? { status } : {}),
    ...(subtype ?? reason ? { subtype: subtype ?? reason } : {}),
  });
  return classified === 'provider_error' && reason ? reason : classified;
}

export function providerFailureHealthReason(reason: ProviderFailureReason): AgentHealthReason | undefined {
  if (reason === 'provider_auth_failed') return 'provider_auth_failed';
  if (reason === 'provider_quota_exhausted') return 'provider_quota_exhausted';
  if (reason === 'provider_rate_limited') return 'provider_rate_limited';
  return undefined;
}

function providerAuthFailed(status: unknown, text: string): boolean {
  return status === 401
    || status === 403
    || /\b(auth|authentication|unauthorized|forbidden|login|sign.?in|api key|token expired|expired token|invalid key)\b/i.test(text);
}

function providerQuotaExhausted(text: string): boolean {
  return /\b(out of tokens|quota|usage limit|plan limit|capacity|credit balance|credits exhausted|insufficient credits|subscription)\b/i.test(text);
}

function stringProperty(value: unknown, key: string): string | undefined {
  const entry = unknownProperty(value, key);
  return typeof entry === 'string' && entry ? entry : undefined;
}

function unknownProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || !(key in value)) return undefined;
  return (value as Record<string, unknown>)[key];
}
