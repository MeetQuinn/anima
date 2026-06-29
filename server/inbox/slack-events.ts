import { nowIso, slackMessageEventId, slackSurfaceId } from '../ids.js';
import { slackFileFromRaw } from '../slack/slack.helper.js';
import { slackMessagePreviewsFromAttachments } from '../slack/message-previews.js';
import type { SlackFileMeta, SlackInboxItem } from '../../shared/inbox.js';
import type { SlackUserProfile } from './slack-profiles.js';

export type SlackEvent = SlackInboxItem;
export type SlackFile = SlackFileMeta;

export interface SlackSurface {
  id: string;
  channelId: string;
  channelName?: string;
  kind: 'channel' | 'dm' | 'thread';
  teamId: string;
  threadTs?: string;
  visibility: 'private' | 'public';
}

export interface SlackMessageEnvelope {
  event_id?: string;
  team_id?: string;
}

export interface SlackRawMessageEvent {
  attachments?: unknown[];
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  files?: Array<{
    id?: string;
    mimetype?: string;
    name?: string;
    size?: number;
    title?: string;
    url_private?: string;
    url_private_download?: string;
  }>;
  subtype?: string;
  team?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  type?: string;
  user?: string;
}

interface SlackUserMessageEvent extends SlackRawMessageEvent {
  channel: string;
  text: string;
  ts: string;
  type: 'app_mention' | 'message';
  user: string;
}

export function isUserAuthoredSlackMessage(event: SlackRawMessageEvent): event is SlackUserMessageEvent {
  return (
    isRoutableSlackMessage(event) &&
    event.bot_id === undefined &&
    event.subtype !== 'bot_message'
  );
}

export function isRoutableSlackMessage(event: SlackRawMessageEvent): event is SlackUserMessageEvent {
  return (
    (event.type === 'message' || event.type === 'app_mention') &&
    typeof event.channel === 'string' &&
    typeof event.ts === 'string' &&
    typeof event.user === 'string' &&
    typeof event.text === 'string' &&
    (event.text.trim().length > 0 || (Array.isArray(event.files) && event.files.length > 0)) &&
    (event.subtype === undefined || event.subtype === 'bot_message' || event.subtype === 'file_share')
  );
}

export function normalizeSlackMessage(input: {
  attentionSuggestion?: string;
  envelope?: SlackMessageEnvelope;
  channelName?: string;
  event: SlackRawMessageEvent;
  files?: SlackFile[];
  permalink?: string;
  text?: string;
  userProfile?: SlackUserProfile;
}): SlackEvent {
  const teamId = input.envelope?.team_id ?? input.event.team ?? 'unknown-team';
  const channelId = input.event.channel!;
  const ts = input.event.ts!;
  const threadTs = input.event.thread_ts || undefined;
  const eventId = slackMessageEventId(teamId, channelId, ts);
  const files = input.files ?? input.event.files?.map(slackFileFromRaw).filter(Boolean) as SlackFile[] | undefined;
  const previews = slackMessagePreviewsFromAttachments(input.event.attachments);

  const handlingAt = nowIso();
  const result: SlackEvent = {
    id: eventId,
    kind: 'slack',
    receivedAt: slackTsToIsoOrNow(ts),
    handling: { createdAt: handlingAt, queuedAt: handlingAt, status: 'queued', updatedAt: handlingAt },
    teamId,
    channelId,
    messageTs: ts,
    actor: { userId: input.event.user!, ...input.userProfile },
    text: input.text ?? input.event.text!,
  };
  if (input.attentionSuggestion) result.attentionSuggestion = input.attentionSuggestion;
  if (input.channelName) result.channelName = input.channelName;
  if (threadTs) result.threadTs = threadTs;
  if (input.permalink) result.permalink = input.permalink;
  if (files?.length) result.files = files;
  if (previews.length) result.previews = previews;
  return result;
}

export function isSlackEvent(event: unknown): event is SlackEvent {
  return Boolean(event && typeof event === 'object' && (event as { kind?: unknown }).kind === 'slack');
}

export function slackSurfaceDisplayRef(surface: SlackSurface): string {
  return surface.channelName && surface.kind !== 'dm' ? `#${surface.channelName}` : surface.channelId;
}

export function slackSurfaceForEvent(event: SlackEvent): SlackSurface {
  return {
    channelId: event.channelId,
    ...(event.channelName ? { channelName: event.channelName } : {}),
    id: slackSurfaceId({
      channelId: event.channelId,
      teamId: event.teamId,
      ...(event.threadTs ? { threadTs: event.threadTs } : {}),
    }),
    kind: slackSurfaceKind(event),
    teamId: event.teamId,
    ...(event.threadTs ? { threadTs: event.threadTs } : {}),
    visibility: slackVisibility(event),
  };
}

function slackTsToIsoOrNow(ts: string): string {
  const seconds = Number(ts.split('.')[0]);
  if (!Number.isFinite(seconds)) return nowIso();
  return new Date(seconds * 1000).toISOString();
}

function slackSurfaceKind(event: SlackEvent): SlackSurface['kind'] {
  if (event.channelId.startsWith('D')) return 'dm';
  if (event.threadTs) return 'thread';
  return 'channel';
}

function slackVisibility(event: SlackEvent): SlackSurface['visibility'] {
  return event.channelId.startsWith('C') ? 'public' : 'private';
}
