import type { ProviderUsageError } from '../../shared/provider-usage.js';

export interface FetchJsonOptions {
  body?: string;
  headers?: Record<string, string>;
  maxAttempts?: number;
  method?: 'GET' | 'POST';
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  telemetryLabel?: string;
  timeoutMs?: number;
  url: string;
}

export interface FetchJsonResult {
  data?: unknown;
  error?: ProviderUsageError;
  status?: number;
}

interface FetchJsonAttemptResult extends FetchJsonResult {
  retryAfterMs?: number;
}

const DEFAULT_GET_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_RETRY_MAX_DELAY_MS = 2_000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export async function fetchJson({
  body,
  headers = {},
  maxAttempts,
  method = 'GET',
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
  telemetryLabel,
  timeoutMs = 10_000,
  url,
}: FetchJsonOptions): Promise<FetchJsonResult> {
  const defaultAttempts = method === 'GET' ? DEFAULT_GET_ATTEMPTS : 1;
  const requestedAttempts = maxAttempts ?? defaultAttempts;
  const attempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, Math.floor(requestedAttempts))
    : defaultAttempts;
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  let attempted = 0;
  let last: FetchJsonAttemptResult | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;
    attempted = attempt;
    last = await fetchJsonAttempt({ body, headers, method, timeoutMs: remainingMs, url });
    if (!shouldRetry(last) || attempt >= attempts) {
      const result = withAttempts(last, attempt);
      logRecoveredRequest({ attempt, result, startedAt, telemetryLabel });
      return result;
    }

    const fallbackDelayMs = retryBaseDelayMs * (2 ** (attempt - 1));
    const jitterMs = fallbackDelayMs * (0.75 + Math.random() * 0.5);
    const requestedDelayMs = Math.max(last.retryAfterMs ?? 0, jitterMs);
    // Do not retry earlier than Retry-After. If the provider asks us to wait
    // longer than this interactive request's retry budget, return the failure
    // and let the server cache/stale fallback absorb it instead.
    if (requestedDelayMs > retryMaxDelayMs || Date.now() + requestedDelayMs >= deadlineAt) {
      const result = withAttempts(last, attempt);
      logRecoveredRequest({ attempt, result, startedAt, telemetryLabel });
      return result;
    }
    await sleep(requestedDelayMs);
  }

  const result = withAttempts(last ?? {
    error: { message: 'Provider usage request failed.', type: 'unknown' },
  }, Math.max(1, attempted));
  logRecoveredRequest({ attempt: Math.max(1, attempted), result, startedAt, telemetryLabel });
  return result;
}

async function fetchJsonAttempt({
  body,
  headers,
  method,
  timeoutMs,
  url,
}: Required<Pick<FetchJsonOptions, 'headers' | 'method' | 'timeoutMs' | 'url'>> &
  Pick<FetchJsonOptions, 'body'>): Promise<FetchJsonAttemptResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      body,
      headers,
      method,
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      return {
        error: {
          message: `Provider usage request was rejected (${response.status})`,
          status: response.status,
          type: 'unauthorized',
        },
        status: response.status,
      };
    }
    if (!response.ok) {
      const retryAfter = retryAfterMs(response.headers.get('retry-after'));
      void response.body?.cancel().catch(() => undefined);
      const result: FetchJsonAttemptResult = {
        error: {
          message: `Provider usage request failed (${response.status})`,
          status: response.status,
          type: 'unknown',
        },
        status: response.status,
      };
      if (retryAfter !== undefined) result.retryAfterMs = retryAfter;
      return result;
    }
    try {
      return { data: await readJsonWithAbort(response, controller.signal), status: response.status };
    } catch (error) {
      if (isAbortLike(error)) throw error;
      return {
        error: {
          message: 'Provider usage response was not valid JSON.',
          status: response.status,
          type: 'parse_error',
        },
        status: response.status,
      };
    }
  } catch (error) {
    return {
      error: {
        type: 'network_error',
        message: providerUsageNetworkErrorMessage(error),
      },
    };
  } finally {
    // Keep the abort alive through response.json(): receiving headers is not a
    // completed usage response, and bodies can stall independently.
    clearTimeout(timeout);
  }
}

function shouldRetry(result: FetchJsonAttemptResult): boolean {
  if (!result.error) return false;
  if (result.error.type === 'network_error') return true;
  return result.status !== undefined && RETRYABLE_STATUSES.has(result.status);
}

function withAttempts(result: FetchJsonAttemptResult, attempts: number): FetchJsonResult {
  const { retryAfterMs: _retryAfterMs, ...publicResult } = result;
  if (!publicResult.error) return publicResult;
  return { ...publicResult, error: { ...publicResult.error, attempts } };
}

function retryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function readJsonWithAbort(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      void response.body?.cancel().catch(() => undefined);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void response.json()
      .then((value) => {
        cleanup();
        if (signal.aborted) reject(abortError());
        else resolve(value);
      })
      .catch((error) => {
        cleanup();
        reject(error);
      });
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function logRecoveredRequest(input: {
  attempt: number;
  result: FetchJsonResult;
  startedAt: number;
  telemetryLabel?: string;
}): void {
  if (!input.telemetryLabel) return;
  const durationMs = Date.now() - input.startedAt;
  if (!input.result.error && input.attempt > 1) {
    console.info(
      `[provider-usage-http] provider=${input.telemetryLabel} outcome=recovered attempts=${input.attempt} durationMs=${durationMs}`,
    );
  }
}

export function bearer(token: string): string {
  const trimmed = token.trim();
  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed : `Bearer ${trimmed}`;
}

export function providerUsageNetworkErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Provider usage request timed out.';
  }

  const cause = error instanceof Error ? error.cause : undefined;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code?: unknown }).code ?? '')
    : '';

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'Provider usage service could not be resolved.';
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'Provider usage request timed out.';
  }
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'UND_ERR_SOCKET') {
    return 'Provider usage connection was interrupted.';
  }
  if (code.includes('CERT') || code.includes('TLS') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return 'Provider usage TLS check failed.';
  }

  return 'Provider usage request could not reach the provider service.';
}
