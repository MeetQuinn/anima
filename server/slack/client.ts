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
  const { WebClient: Client } = slackWebApi();
  return new Client(token, {
    ...slackWebClientOptions(),
    timeout: 1_000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    requestInterceptor: (config) => ({ ...config, signal }),
  });
}

export function slackWebClientOptions(): WebClientOptions {
  return process.env.ANIMA_SLACK_API_URL ? { slackApiUrl: process.env.ANIMA_SLACK_API_URL } : {};
}
