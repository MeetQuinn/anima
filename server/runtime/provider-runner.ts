import { errorMessage, nowIso } from '../ids.js';
import { recordRuntimeActivity, recordRuntimeEvent } from './activity.js';
import { defaultAgentHealthService } from './agent-health.service.js';
import { runtimeErrorPayload } from '../activities/format.js';
import {
  buildProviderCrashRetryDeliveryPrompt,
  buildProviderSessionRecoveryDeliveryPrompt,
  buildProviderTransientRetryDeliveryPrompt,
} from './delivery-prompt.js';
import { providerFailureHealthReason, providerFailureReasonFromError } from '../providers/provider-failure.js';
import {
  classifyProviderRetry,
  isProviderCrashError,
  providerRateLimitResumeAt,
  type ProviderRetryClass,
} from '../providers/provider-retry.js';
import type { AgentRuntime, AgentRuntimeInput, AgentRuntimeResult } from '../providers/contract.js';
import {
  isProviderSessionCorruptionError,
  type ProviderSessionCorruptionError,
} from '../providers/session-corruption.js';

const PROVIDER_CRASH_MAX_RETRIES = 3;
const PROVIDER_CRASH_RETRY_BACKOFF_MS = 500;
export const PROVIDER_TRANSIENT_MAX_RETRIES = 3;
/** Backoff before transient retry n (1-based); provider outages rarely clear in under seconds. */
export const PROVIDER_TRANSIENT_RETRY_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000];

/**
 * Raised by {@link runProviderWithCrashRetries} when the provider is rate
 * limited: the item should be deferred (not failed) until `resumeAt`.
 */
export class ProviderRateLimitedError extends Error {
  readonly cause: unknown;
  readonly resumeAt: Date;

  constructor(cause: unknown, resumeAt: Date) {
    super(errorMessage(cause));
    this.name = 'ProviderRateLimitedError';
    this.cause = cause;
    this.resumeAt = resumeAt;
  }
}

export function isProviderRateLimitedError(error: unknown): error is ProviderRateLimitedError {
  return error instanceof ProviderRateLimitedError;
}

export interface RecordedProviderFailure {
  error: unknown;
  retryAttempts: number;
  retryClass: ProviderRetryClass;
}

export interface ProviderRetryOptions {
  /** Test seam: override the transient retry backoff schedule. */
  transientBackoffMs?: readonly number[];
}

export async function runProviderWithCrashRetries(input: {
  agentId: string;
  agentRuntime: AgentRuntime;
  buildInput: (retryNotice?: string) => Promise<AgentRuntimeInput>;
  itemId?: string;
  onFinalFailureRecorded?: (failure: RecordedProviderFailure) => void;
  recoverCorruptSession?: (error: ProviderSessionCorruptionError) => Promise<boolean>;
  retry?: ProviderRetryOptions;
  signal: AbortSignal;
}): Promise<AgentRuntimeResult> {
  let retryCount = 0;
  let transientRetryCount = 0;
  const transientBackoff = input.retry?.transientBackoffMs ?? PROVIDER_TRANSIENT_RETRY_BACKOFF_MS;
  // Transcript repair is independent of the ordinary process-crash retry budget.
  let sessionRecoveryAttempted = false;
  let retryNotice: string | undefined;
  let previousError: unknown;
  for (;;) {
    try {
      return await input.agentRuntime.run(await input.buildInput(retryNotice));
    } catch (error) {
      previousError = error;
      if (input.signal.aborted) throw error;
      // Transcript corruption is a typed, adapter-identified condition; it must
      // win over text-based retry classification.
      if (
        isProviderSessionCorruptionError(error)
        && !sessionRecoveryAttempted
        && input.recoverCorruptSession
      ) {
        sessionRecoveryAttempted = true;
        await input.agentRuntime.close?.();
        if (await input.recoverCorruptSession(error)) {
          retryNotice = buildProviderSessionRecoveryDeliveryPrompt({
            itemId: input.itemId,
            time: nowIso(),
          });
          continue;
        }
      }
      const retryClass = classifyProviderRetry(error);
      if (retryClass === 'rate_limited') {
        const resumeAt = providerRateLimitResumeAt(error, new Date());
        await recordRuntimeEvent(
          { agentId: input.agentId, ...(input.itemId ? { itemId: input.itemId } : {}) },
          input.agentRuntime.kind,
          input.agentRuntime.env,
          {
            error: errorMessage(error),
            eventType: 'provider.rate_limit.defer',
            resumeAt: resumeAt.toISOString(),
          },
        );
        await writeProviderFailureHealth(input.agentId, 'provider_rate_limited');
        await input.agentRuntime.close?.();
        throw new ProviderRateLimitedError(error, resumeAt);
      }
      if (retryClass === 'transient' && transientRetryCount < PROVIDER_TRANSIENT_MAX_RETRIES) {
        transientRetryCount += 1;
        const retryAfterMs = transientBackoff[transientRetryCount - 1]
          ?? transientBackoff[transientBackoff.length - 1]
          ?? 0;
        retryNotice = buildProviderTransientRetryDeliveryPrompt({
          attempt: transientRetryCount,
          itemId: input.itemId,
          maxRetries: PROVIDER_TRANSIENT_MAX_RETRIES,
          previousError: errorMessage(error),
          time: nowIso(),
        });
        await recordRuntimeEvent(
          { agentId: input.agentId, ...(input.itemId ? { itemId: input.itemId } : {}) },
          input.agentRuntime.kind,
          input.agentRuntime.env,
          {
            attempt: transientRetryCount,
            error: errorMessage(error),
            eventType: 'provider.transient.retry',
            maxRetries: PROVIDER_TRANSIENT_MAX_RETRIES,
            retryAfterMs,
          },
        );
        await input.agentRuntime.close?.();
        await sleep(retryAfterMs, input.signal);
        if (input.signal.aborted) throw error;
        continue;
      }
      if (retryClass !== 'crash' || retryCount >= PROVIDER_CRASH_MAX_RETRIES) {
        const retryAttempts = retryClass === 'transient' ? transientRetryCount : retryCount;
        await recordFinalRuntimeFailure({
          agentId: input.agentId,
          agentRuntime: input.agentRuntime,
          error,
          ...(input.itemId ? { itemId: input.itemId } : {}),
          providerFailure: true,
          retryAttempts,
          retryClass,
        });
        input.onFinalFailureRecorded?.({ error, retryAttempts, retryClass });
        throw error;
      }

      retryCount += 1;
      retryNotice = retryNoticeFor({
        itemId: input.itemId,
        previousError,
        retryCount,
      });
      const retryAfterMs = PROVIDER_CRASH_RETRY_BACKOFF_MS * retryCount;
      await recordRuntimeEvent(
        { agentId: input.agentId, ...(input.itemId ? { itemId: input.itemId } : {}) },
        input.agentRuntime.kind,
        input.agentRuntime.env,
        {
          attempt: retryCount,
          error: errorMessage(error),
          eventType: 'provider.crash.retry',
          maxRetries: PROVIDER_CRASH_MAX_RETRIES,
          retryAfterMs,
        },
      );
      await input.agentRuntime.close?.();
      await sleep(retryAfterMs, input.signal);
    }
  }
}

export async function recordFinalRuntimeFailure(input: {
  agentId: string;
  agentRuntime: AgentRuntime;
  error: unknown;
  itemId?: string;
  providerFailure?: boolean;
  retryAttempts: number;
  retryClass?: ProviderRetryClass;
}): Promise<void> {
  const processCrash = isProviderCrashError(input.error);
  const providerReason = input.providerFailure
    ? processCrash ? 'process_crash' : providerFailureReasonFromError(input.error)
    : undefined;
  const retryClass = input.retryClass ?? (input.providerFailure ? classifyProviderRetry(input.error) : undefined);
  const maxRetries = retryClass === 'transient' ? PROVIDER_TRANSIENT_MAX_RETRIES : PROVIDER_CRASH_MAX_RETRIES;
  await recordRuntimeActivity(
    { agentId: input.agentId, ...(input.itemId ? { itemId: input.itemId } : {}) },
    input.agentRuntime.kind,
    'runtime.failed',
    {
      ...runtimeErrorPayload(input.error),
      ...(input.providerFailure
        ? {
            failureSource: 'provider',
            maxRetries,
            providerReason,
            retryAttempts: input.retryAttempts,
            retryable: false,
            ...(retryClass ? { retryClass } : {}),
          }
      : {}),
    },
  );
  if (providerReason) {
    const healthReason = providerFailureHealthReason(providerReason);
    if (healthReason) await writeProviderFailureHealth(input.agentId, healthReason);
  }
}

async function writeProviderFailureHealth(
  agentId: string,
  reason: NonNullable<ReturnType<typeof providerFailureHealthReason>>,
): Promise<void> {
  await defaultAgentHealthService.writeProviderFailure({
    agentId,
    reason,
    updatedAt: nowIso(),
  });
}

function retryNoticeFor(input: {
  itemId?: string;
  previousError: unknown;
  retryCount: number;
}): string | undefined {
  if (input.retryCount === 0) return undefined;
  return buildProviderCrashRetryDeliveryPrompt({
    attempt: input.retryCount,
    itemId: input.itemId,
    maxRetries: PROVIDER_CRASH_MAX_RETRIES,
    previousError: errorMessage(input.previousError),
    time: nowIso(),
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
