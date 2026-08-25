import { errorMessage } from '../ids.js';
import { providerFailureReasonFromError } from './provider-failure.js';

/**
 * How the runtime should react to a failed provider turn.
 *
 * - `crash`: the provider child exited mid-turn; retry the same item quickly.
 * - `transient`: the provider API failed in a way that usually clears on its
 *   own (5xx, overload, network/stream stalls, safeguard false positives);
 *   retry the same item on the same session with backoff.
 * - `rate_limited`: the provider refused for quota reasons; defer the item
 *   until the reported reset instant instead of failing it.
 * - `terminal`: nothing the runtime can do (auth, malformed request); fail
 *   the item and tell the requester.
 */
export type ProviderRetryClass = 'crash' | 'transient' | 'rate_limited' | 'terminal';

const CRASH_PATTERN = /runtime exited before completing|runtime terminated by|runtime exited with code|stdin is closed/i;

const TRANSIENT_PATTERN = new RegExp([
  String.raw`\b(?:5\d\d|408)\b`,
  'overloaded',
  'safeguards flagged',
  'unable to connect',
  'certificate',
  String.raw`\bssl\b`,
  String.raw`\btls\b`,
  'socket',
  'connection',
  'timeout',
  'timed out',
  'network',
  String.raw`\bfetch\b`,
  'stream',
  'response stopped arriving',
  'stalled mid-stream',
  'may be incomplete',
  'internal error',
  'reqwest',
  String.raw`\bE(?:CONN\w+|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)\b`,
].join('|'), 'i');

export function isProviderCrashError(error: unknown): boolean {
  return CRASH_PATTERN.test(errorMessage(error));
}

export function classifyProviderRetry(error: unknown): ProviderRetryClass {
  if (isProviderCrashError(error)) return 'crash';
  const reason = providerFailureReasonFromError(error);
  if (reason === 'provider_rate_limited' || reason === 'provider_quota_exhausted') return 'rate_limited';
  if (reason === 'provider_auth_failed') return 'terminal';
  if (booleanProperty(error, 'retryable') === true) return 'transient';
  if (TRANSIENT_PATTERN.test(errorMessage(error))) return 'transient';
  return 'terminal';
}

const DEFAULT_RATE_LIMIT_DEFER_MS = 5 * 60 * 1000;
const MAX_RATE_LIMIT_DEFER_MS = 6 * 60 * 60 * 1000;
const MIN_RATE_LIMIT_DEFER_MS = 30 * 1000;

/**
 * When the provider should be tried again after a rate limit. Reads an
 * explicit `resetsAt` property when the adapter attached one, otherwise parses
 * the human text Claude Code prints ("resets 2:10pm (Asia/Shanghai)",
 * "resets at 14:10", "try again in 30 seconds"). Falls back to a fixed delay.
 */
export function providerRateLimitResumeAt(error: unknown, now: Date): Date {
  const candidate = explicitResetAt(error) ?? parsedResetAt(errorMessage(error), now);
  const delta = candidate ? candidate.getTime() - now.getTime() : DEFAULT_RATE_LIMIT_DEFER_MS;
  const bounded = Math.min(Math.max(delta, MIN_RATE_LIMIT_DEFER_MS), MAX_RATE_LIMIT_DEFER_MS);
  return new Date(now.getTime() + bounded);
}

function explicitResetAt(error: unknown): Date | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>)['resetsAt'];
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms) : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds or milliseconds since epoch.
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  return undefined;
}

function parsedResetAt(text: string, now: Date): Date | undefined {
  const relative = /(?:try again|retry|resets?)\s+(?:in|after)\s+(\d+)\s*(second|sec|minute|min|hour|hr)s?\b/i.exec(text);
  if (relative) {
    const amount = Number.parseInt(relative[1] ?? '0', 10);
    const unit = (relative[2] ?? '').toLowerCase();
    const unitMs = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000;
    return new Date(now.getTime() + amount * unitMs);
  }
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(text);
  if (!clock) return undefined;
  let hour = Number.parseInt(clock[1] ?? '0', 10);
  const minute = Number.parseInt(clock[2] ?? '0', 10);
  const meridiem = clock[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const wall = wallClockMinutes(now, clock[4]);
  if (wall === undefined) return undefined;
  let deltaMinutes = hour * 60 + minute - wall;
  if (deltaMinutes <= 0) deltaMinutes += 24 * 60;
  return new Date(now.getTime() + deltaMinutes * 60_000);
}

/** Minutes since local midnight of `now` in `timeZone` (IANA name or undefined for host zone). */
function wallClockMinutes(now: Date, timeZone: string | undefined): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
      ...(timeZone ? { timeZone: timeZone.trim() } : {}),
    }).formatToParts(now);
    const hour = Number.parseInt(parts.find((part) => part.type === 'hour')?.value ?? '', 10);
    const minute = Number.parseInt(parts.find((part) => part.type === 'minute')?.value ?? '', 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
    return (hour % 24) * 60 + minute;
  } catch {
    return timeZone ? wallClockMinutes(now, undefined) : undefined;
  }
}

function booleanProperty(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) return undefined;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'boolean' ? entry : undefined;
}
