import type { WebClient } from '@slack/web-api';

import { errorMessage } from '../ids.js';
import type { SlackMessagePreview, SlackMessagePreviewFile } from '../../shared/inbox.js';
import { decodeSlackEntities, slackFileFromRaw, type SlackRawFile } from './slack.helper.js';

// Slack message previews come exclusively from unfurl attachments Slack itself
// delivers on the containing message. Nothing in this module reads the linked
// target channel or DM: the only Slack call is a single-message re-read of the
// containing message (channelId + messageTs of the inbound event), used because
// unfurls can arrive after the realtime event.

export function slackMessagePreviewsFromAttachments(rawAttachments: unknown): SlackMessagePreview[] {
  if (!Array.isArray(rawAttachments)) return [];
  const previews: SlackMessagePreview[] = [];
  const seen = new Set<string>();

  for (const raw of rawAttachments) {
    if (!raw || typeof raw !== 'object') continue;
    const attachment = raw as Record<string, unknown>;
    const isMessageUnfurl =
      attachment['is_msg_unfurl'] === true || attachment['type'] === 'message_mention';
    if (!isMessageUnfurl) continue;

    const fromUrl =
      stringField(attachment, 'from_url') ??
      stringField(attachment, 'original_url') ??
      stringField(attachment, 'url');
    const channelId = stringField(attachment, 'channel_id');
    if (!fromUrl && !channelId) continue;

    const rawText =
      stringField(attachment, 'text') ??
      stringField(attachment, 'fallback') ??
      textFromBlocks(attachment['blocks']);
    if (!rawText) continue;
    // Preview text reaches agent prompts: decode Slack's HTML escapes like
    // ingested message text (see decodeSlackEntities).
    const text = decodeSlackEntities(rawText);

    const authorId = stringField(attachment, 'author_id');
    const authorName = stringField(attachment, 'author_name');
    const authorSubname = stringField(attachment, 'author_subname');
    const files = slackMessagePreviewFiles(attachment['files']);
    const messageTs = stringField(attachment, 'ts');
    const preview: SlackMessagePreview = {
      text,
      ...(authorId ? { authorId } : {}),
      ...(authorName ? { authorName } : {}),
      ...(authorSubname ? { authorSubname } : {}),
      ...(channelId ? { channelId } : {}),
      ...(files.length ? { files } : {}),
      ...(fromUrl ? { fromUrl } : {}),
      ...(attachment['private_channel_prompt'] === true ? { isPrivate: true } : {}),
      ...(messageTs ? { messageTs } : {}),
    };
    const key = [
      preview.fromUrl ?? '',
      preview.channelId ?? '',
      preview.messageTs ?? '',
      preview.text,
    ].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    previews.push(preview);
  }

  return previews;
}

function slackMessagePreviewFiles(rawFiles: unknown): SlackMessagePreviewFile[] {
  if (!Array.isArray(rawFiles)) return [];
  const files: SlackMessagePreviewFile[] = [];
  const seen = new Set<string>();
  for (const raw of rawFiles) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const file = slackFileFromRaw(record as SlackRawFile);
    if (!file || seen.has(file.id)) continue;
    seen.add(file.id);
    // The file id is enough for `anima file fetch`; never persist Slack's
    // token-authenticated download URL in the inbox or provider prompt.
    const { urlPrivate: _, ...meta } = file;
    const permalink = stringField(record, 'permalink');
    files.push({ ...meta, ...(permalink ? { permalink } : {}) });
  }
  return files;
}

// Immediate read, then retries at ~2s and ~7s; network time shares the 8s budget.
const SLACK_MESSAGE_PREVIEW_RETRY_DELAYS_MS = [0, 2_000, 5_000] as const;
const SLACK_MESSAGE_PREVIEW_TIMEOUT_MS = 8_000;

type SlackPreviewWebClient = Pick<WebClient, 'conversations'>;

export interface SlackMessagePreviewRetryInput {
  channelId: string;
  client: SlackPreviewWebClient;
  createClient?: (signal: AbortSignal) => SlackPreviewWebClient;
  messageTs: string;
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
  text?: string;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

// Unfurl attachments for shared Slack permalinks are added by Slack after the
// realtime event fires, so an immediate read can miss them. Re-read the
// containing message a couple of times before giving up.
export async function waitForSlackMessagePreviewAttachments(
  input: SlackMessagePreviewRetryInput,
): Promise<unknown[] | undefined> {
  if (!slackPermalinkMentioned(input.text)) return undefined;
  const retryDelaysMs = input.retryDelaysMs ?? SLACK_MESSAGE_PREVIEW_RETRY_DELAYS_MS;
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeoutMs = input.timeoutMs ?? SLACK_MESSAGE_PREVIEW_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sleepTimer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  const client = input.createClient?.(controller.signal) ?? input.client;
  const lookup = async (): Promise<unknown[] | undefined> => {
    let nextAttemptAt = startedAt;
    for (const delayMs of retryDelaysMs) {
      nextAttemptAt += delayMs;
      const waitMs = Math.max(0, nextAttemptAt - performance.now());
      if (waitMs > 0) {
        await (input.sleep?.(waitMs) ?? new Promise<void>((resolve) => {
          sleepTimer = setTimeout(resolve, waitMs);
        }));
      }
      if (controller.signal.aborted || performance.now() - startedAt >= timeoutMs) return undefined;
      const attachments = await slackMessageAttachments({ ...input, client });
      if (controller.signal.aborted) return undefined;
      if (attachmentsHaveSlackMessagePreviews(attachments)) return attachments;
    }
    return undefined;
  };
  try {
    // Also bounds injected/non-cooperative clients. No late result mutates a
    // queued item; the production transport is aborted at this same boundary.
    return await Promise.race([lookup(), expired]);
  } finally {
    clearTimeout(timer);
    clearTimeout(sleepTimer);
    controller.abort();
  }
}

// Re-reads ONLY the containing message (the message that just arrived) to pick
// up its Slack-provided unfurl attachments. Never fetches the linked target.
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

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function textFromBlocks(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const parts: string[] = [];
  collectText(blocks, parts);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

function collectText(value: unknown, parts: string[]): void {
  if (typeof value === 'string') {
    if (value.trim()) parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectText(entry, parts);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record['text'] === 'string') parts.push(record['text']);
  if (Array.isArray(record['elements'])) collectText(record['elements'], parts);
}
