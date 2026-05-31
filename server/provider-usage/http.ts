import type { ProviderUsageError } from '../../shared/provider-usage.js';

export interface FetchJsonOptions {
  body?: string;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  timeoutMs?: number;
  url: string;
}

export interface FetchJsonResult {
  data?: unknown;
  error?: ProviderUsageError;
  status?: number;
}

export async function fetchJson({
  body,
  headers = {},
  method = 'GET',
  timeoutMs = 10_000,
  url,
}: FetchJsonOptions): Promise<FetchJsonResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      body,
      headers,
      method,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.status === 401 || response.status === 403) {
      return {
        error: { type: 'unauthorized', message: `Provider usage request was rejected (${response.status})` },
        status: response.status,
      };
    }
    if (!response.ok) {
      return {
        error: { type: 'unknown', message: `Provider usage request failed (${response.status})` },
        status: response.status,
      };
    }
    return { data: await response.json(), status: response.status };
  } catch (error) {
    clearTimeout(timeout);
    return {
      error: {
        type: 'network_error',
        message: providerUsageNetworkErrorMessage(error),
      },
    };
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
