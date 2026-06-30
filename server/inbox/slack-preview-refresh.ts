import type { WebClient } from '@slack/web-api';

import { errorMessage } from '../ids.js';
import { slackMessagePreviewsFromAttachments } from '../slack/message-previews.js';

export const DEFAULT_SLACK_MESSAGE_PREVIEW_RETRY_DELAYS_MS = [2_000, 5_000] as const;

type SlackPreviewWebClient = Pick<WebClient, 'conversations'>;

export interface SlackMessagePreviewRetryInput {
  channelId: string;
  client: SlackPreviewWebClient;
  messageTs: string;
  retryDelaysMs?: readonly number[];
  text?: string;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

export async function waitForSlackMessagePreviewAttachments(
  input: SlackMessagePreviewRetryInput,
): Promise<unknown[] | undefined> {
  if (!slackPermalinkMentioned(input.text)) return undefined;
  const retryDelaysMs = input.retryDelaysMs ?? DEFAULT_SLACK_MESSAGE_PREVIEW_RETRY_DELAYS_MS;
  const sleep = input.sleep ?? sleepMs;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await sleep(delayMs);
    const attachments = await slackMessageAttachments({
      channelId: input.channelId,
      client: input.client,
      messageTs: input.messageTs,
      text: input.text,
      warn: input.warn,
    });
    if (!attachmentsHaveSlackMessagePreviews(attachments)) continue;
    return attachments;
  }
  return undefined;
}

export async function slackMessageAttachments(input: {
  channelId?: string;
  client: SlackPreviewWebClient;
  messageTs?: string;
  text?: string;
  warn?: (message: string) => void;
}): Promise<unknown[] | undefined> {
  if (!input.channelId || !input.messageTs || !slackPermalinkMentioned(input.text)) return undefined;
  try {
    const response = await input.client.conversations.history({
      channel: input.channelId,
      inclusive: true,
      latest: input.messageTs,
      limit: 1,
      oldest: input.messageTs,
    });
    const message = response.messages?.find((entry) => entry.ts === input.messageTs) as
      | { attachments?: unknown[] }
      | undefined;
    return Array.isArray(message?.attachments) ? message.attachments : undefined;
  } catch (error) {
    input.warn?.(`Slack message preview lookup failed for ${input.channelId}/${input.messageTs}: ${errorMessage(error)}`);
    return undefined;
  }
}

export function attachmentsHaveSlackMessagePreviews(attachments: unknown): boolean {
  return slackMessagePreviewsFromAttachments(attachments).length > 0;
}

export function slackPermalinkMentioned(text: string | undefined): boolean {
  return Boolean(text && /https:\/\/[^\s|>]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d{10,}/.test(text));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
