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
  const status = statusCode(input.status);
  if (status === 401 || status === 403) return 'provider_auth_failed';
  if (status === 429) return 'provider_rate_limited';
  if (providerAuthFailed(input.status, text)) return 'provider_auth_failed';
  if (providerQuotaExhausted(text)) return 'provider_quota_exhausted';
  if (/\b(rate limit|rate-limit|rate_limit|too many requests)\b/i.test(text)) {
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
  if (reason === 'provider_error') return 'provider_error';
  if (reason === 'provider_rate_limited') return 'provider_rate_limited';
  return undefined;
}

function providerAuthFailed(status: unknown, text: string): boolean {
  return status === 401
    || status === 403
    || /\b(authentication|unauthorized|forbidden|api key|token expired|expired token|invalid key)\b/i.test(text);
}

function providerQuotaExhausted(text: string): boolean {
  return /\b(out of tokens|quota|usage limit|plan limit|credit balance|credits exhausted|insufficient credits)\b/i.test(text);
}

function statusCode(status: unknown): number | undefined {
  if (typeof status === 'number' && Number.isInteger(status)) return status;
  if (typeof status === 'string' && /^[0-9]{3}$/.test(status)) return Number.parseInt(status, 10);
  return undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const entry = unknownProperty(value, key);
  return typeof entry === 'string' && entry ? entry : undefined;
}

function unknownProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || !(key in value)) return undefined;
  return (value as Record<string, unknown>)[key];
}
