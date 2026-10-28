import type * as SlackWebApi from '@slack/web-api';
import type { WebClient, WebClientOptions } from '@slack/web-api';

import { lazyRequire } from '../lazy-require.js';

// Load the Slack SDK (with axios) only when a call builds a client.
const slackWebApi = lazyRequire<typeof SlackWebApi>('@slack/web-api');

export function createSlackWebClient(token: string, options: WebClientOptions = {}): WebClient {
  const { WebClient: Client } = slackWebApi();
  return new Client(token, { ...slackWebClientOptions(), ...options });
}

// Preview enrichment has its own deadline. Never leave SDK retries or a 429
// backoff running after the original message has been delivered without it.
export function createSlackPreviewWebClient(token: string, signal: AbortSignal): WebClient {
  return createSlackDeadlineWebClient(token, signal, 1_000);
}

// For best-effort reads under a caller's deadline: one attempt per call, each
// bounded by `requestTimeoutMs`, a 429 rejected at once instead of waited out,
// and every in-flight request cancelled when `signal` aborts. Callers handle
// the failures they expect, so the SDK's own warnings (printed into CLI
// output) stay off.
export function createSlackDeadlineWebClient(token: string, signal: AbortSignal, requestTimeoutMs: number): WebClient {
  const { LogLevel, WebClient: Client } = slackWebApi();
  return new Client(token, {
    ...slackWebClientOptions(),
    logLevel: LogLevel.ERROR,
    timeout: requestTimeoutMs,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    requestInterceptor: (config) => ({ ...config, signal }),
  });
}

export function slackWebClientOptions(): WebClientOptions {
  return process.env.ANIMA_SLACK_API_URL ? { slackApiUrl: process.env.ANIMA_SLACK_API_URL } : {};
}
