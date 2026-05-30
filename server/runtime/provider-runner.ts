import { errorMessage } from '../ids.js';
import { recordRuntimeActivity, recordRuntimeEvent } from './activity.js';
import { runtimeErrorPayload } from './activity-text.js';
import { buildProviderCrashRetryDeliveryPrompt } from './delivery-prompt.js';
import type { AgentRuntime, AgentRuntimeInput, AgentRuntimeResult } from './provider-contract.js';

const PROVIDER_CRASH_MAX_RETRIES = 3;
const PROVIDER_CRASH_RETRY_BACKOFF_MS = 500;

export async function runProviderWithCrashRetries(input: {
  agentId: string;
  agentRuntime: AgentRuntime;
  buildInput: (retryNotice?: string) => Promise<AgentRuntimeInput>;
  onFinalFailureRecorded?: () => void;
  signal: AbortSignal;
}): Promise<AgentRuntimeResult> {
  let retryCount = 0;
  let previousError: unknown;
  for (;;) {
    try {
      return await input.agentRuntime.run(await input.buildInput(retryNoticeFor(retryCount, previousError)));
    } catch (error) {
      previousError = error;
      if (input.signal.aborted) throw error;
      if (!isProviderCrashError(error) || retryCount >= PROVIDER_CRASH_MAX_RETRIES) {
        await recordFinalRuntimeFailure({
          agentId: input.agentId,
          agentRuntime: input.agentRuntime,
          error,
          providerFailure: true,
          retryAttempts: retryCount,
        });
        input.onFinalFailureRecorded?.();
        throw error;
      }

      retryCount += 1;
      const retryAfterMs = PROVIDER_CRASH_RETRY_BACKOFF_MS * retryCount;
      await recordRuntimeEvent(
        { agentId: input.agentId },
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
  providerFailure?: boolean;
  retryAttempts: number;
}): Promise<void> {
  const processCrash = isProviderCrashError(input.error);
  await recordRuntimeActivity(
    { agentId: input.agentId },
    input.agentRuntime.kind,
    'runtime.failed',
    {
      ...runtimeErrorPayload(input.error),
      ...(input.providerFailure
        ? {
            failureSource: 'provider',
            maxRetries: PROVIDER_CRASH_MAX_RETRIES,
            providerReason: processCrash ? 'process_crash' : 'provider_error',
            retryAttempts: input.retryAttempts,
            retryable: processCrash && input.retryAttempts < PROVIDER_CRASH_MAX_RETRIES,
          }
        : {}),
    },
  );
}

function retryNoticeFor(retryCount: number, previousError: unknown): string | undefined {
  if (retryCount === 0) return undefined;
  return buildProviderCrashRetryDeliveryPrompt({
    attempt: retryCount,
    maxRetries: PROVIDER_CRASH_MAX_RETRIES,
    previousError: errorMessage(previousError),
  });
}

function isProviderCrashError(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /runtime exited before completing/i.test(message) ||
    /runtime terminated by/i.test(message) ||
    /runtime exited with code/i.test(message) ||
    /stdin is closed/i.test(message)
  );
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
