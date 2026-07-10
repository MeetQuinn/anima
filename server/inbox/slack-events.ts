import { nowIso, slackMessageEventId, slackSurfaceId } from '../ids.js';
import { normalizeSlackEventFiles, slackTsToIso, type SlackRawFile } from '../slack/slack.helper.js';
import { slackMessagePreviewsFromAttachments } from '../slack/message-previews.js';
import { slackVisibleMessageText } from '../slack/message-text.js';
import type { SlackInboxActor, SlackInboxItem } from '../../shared/inbox.js';
import type { SlackUserProfile } from '../slack/profiles.js';

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
  team_id?: string;
}

export interface SlackRawMessageEvent {
  attachments?: unknown[];
  blocks?: unknown;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  files?: SlackRawFile[];
  subtype?: string;
  team?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  type?: string;
  user?: string;
}

export interface RoutableSlackMessage extends SlackRawMessageEvent {
  channel: string;
  text: string;
  ts: string;
  type: 'app_mention' | 'message';
  user: string;
}

export function isRoutableSlackMessage(event: SlackRawMessageEvent): event is RoutableSlackMessage {
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

export function slackEventTeamId(
  envelope: SlackMessageEnvelope | undefined,
  event: SlackRawMessageEvent,
): string {
  return envelope?.team_id ?? event.team ?? 'unknown-team';
}

export function normalizeSlackMessage(input: {
  attachments?: unknown[];
  attentionSuggestion?: string;
  envelope?: SlackMessageEnvelope;
  channelName?: string;
  event: RoutableSlackMessage;
  permalink?: string;
  text?: string;
  userProfile?: SlackUserProfile;
}): SlackInboxItem {
  const teamId = slackEventTeamId(input.envelope, input.event);
  const channelId = input.event.channel;
  const ts = input.event.ts;
  const threadTs = input.event.thread_ts || undefined;
  const files = normalizeSlackEventFiles(input.event.files);
  const previews = slackMessagePreviewsFromAttachments(input.attachments ?? input.event.attachments);

  const handlingAt = nowIso();
  const result: SlackInboxItem = {
    id: slackMessageEventId(teamId, channelId, ts),
    kind: 'slack',
    receivedAt: slackTsToIso(ts) ?? nowIso(),
    handling: { createdAt: handlingAt, queuedAt: handlingAt, status: 'queued', updatedAt: handlingAt },
    teamId,
    channelId,
    messageTs: ts,
    actor: slackInboxActor(input.event.user, input.userProfile),
    text: input.text ?? slackVisibleMessageText(input.event) ?? input.event.text,
  };
  if (input.attentionSuggestion) result.attentionSuggestion = input.attentionSuggestion;
  if (input.channelName) result.channelName = input.channelName;
  if (threadTs) result.threadTs = threadTs;
  if (input.permalink) result.permalink = input.permalink;
  if (files?.length) result.files = files;
  if (previews.length) result.previews = previews;
  return result;
}

export function isSlackEvent(event: unknown): event is SlackInboxItem {
  return Boolean(event && typeof event === 'object' && (event as { kind?: unknown }).kind === 'slack');
}

export function slackSurfaceDisplayRef(surface: SlackSurface): string {
  return surface.channelName && surface.kind !== 'dm' ? `#${surface.channelName}` : surface.channelId;
}

export function slackSurfaceForEvent(event: SlackInboxItem): SlackSurface {
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

// The inbox item keeps only the actor fields the prompt and ledger read;
// resolver extras such as avatarUrl stay read-time-only.
function slackInboxActor(userId: string, profile: SlackUserProfile | undefined): SlackInboxActor {
  const actor: SlackInboxActor = { userId };
  if (profile?.displayName) actor.displayName = profile.displayName;
  if (profile?.handle) actor.handle = profile.handle;
  if (profile?.isBot) actor.isBot = true;
  if (profile?.realName) actor.realName = profile.realName;
  // Recorded even for bots. The envelope declines to render it (see
  // delivery-prompt.ts); the ledger stays faithful to what Slack reported.
  if (profile?.timezone) actor.timezone = profile.timezone;
  return actor;
}

function slackSurfaceKind(event: SlackInboxItem): SlackSurface['kind'] {
  if (event.channelId.startsWith('D')) return 'dm';
  if (event.threadTs) return 'thread';
  return 'channel';
}

function slackVisibility(event: SlackInboxItem): SlackSurface['visibility'] {
  return event.channelId.startsWith('C') ? 'public' : 'private';
}
