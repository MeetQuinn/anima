import type { SlackMessagePreview } from '../../shared/inbox.js';

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

    const text =
      stringField(attachment, 'text') ??
      stringField(attachment, 'fallback') ??
      textFromBlocks(attachment['blocks']);
    if (!text) continue;

    const authorId = stringField(attachment, 'author_id');
    const authorName = stringField(attachment, 'author_name');
    const authorSubname = stringField(attachment, 'author_subname');
    const messageTs = stringField(attachment, 'ts');
    const preview: SlackMessagePreview = {
      text,
      ...(authorId ? { authorId } : {}),
      ...(authorName ? { authorName } : {}),
      ...(authorSubname ? { authorSubname } : {}),
      ...(channelId ? { channelId } : {}),
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
