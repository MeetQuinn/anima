import { WebClient, type WebClientOptions } from '@slack/web-api';

export function createSlackWebClient(token: string, options: WebClientOptions = {}): WebClient {
  return new WebClient(token, { ...slackWebClientOptions(), ...options });
}

// Preview enrichment has its own deadline. Never leave SDK retries or a 429
// backoff running after the original message has been delivered without it.
export function createSlackPreviewWebClient(token: string, signal: AbortSignal): WebClient {
  return new WebClient(token, {
    ...slackWebClientOptions(),
    timeout: 1_000,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    requestInterceptor: (config) => ({ ...config, signal }),
  });
}

function slackWebClientOptions(): WebClientOptions {
  return process.env.ANIMA_SLACK_API_URL ? { slackApiUrl: process.env.ANIMA_SLACK_API_URL } : {};
}
