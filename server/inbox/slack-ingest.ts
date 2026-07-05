import type { WebClient } from '@slack/web-api';

import { errorMessage } from '../ids.js';
import {
  attachmentsHaveSlackMessagePreviews,
  slackMessagePreviewsFromAttachments,
  slackMessageAttachments,
  waitForSlackMessagePreviewAttachments,
} from '../slack/message-previews.js';
import { SlackProfileResolver } from '../slack/profiles.js';
import type { SlackInboxItem } from '../../shared/inbox.js';
import {
  normalizeSlackMessage,
  slackEventTeamId,
  type RoutableSlackMessage,
  type SlackMessageEnvelope,
} from './slack-events.js';

export interface SlackIngestInput {
  attentionSuggestion?: string;
  client: WebClient;
  envelope?: SlackMessageEnvelope;
  event: RoutableSlackMessage;
  profiles?: SlackProfileResolver;
  warn?: (message: string) => void;
}

export interface SlackInboxBuildResult {
  item: SlackInboxItem;
  latePreview?: (item: SlackInboxItem) => Promise<SlackInboxItem | undefined>;
}

// Turns one routable Slack event into a fully enriched inbox item: sender and
// channel profiles, readable mention text, permalink, unfurl previews, and file
// metadata. Every Slack lookup is best-effort — a failure degrades that field
// and never blocks the wake. Privacy boundary: the only message-content read is
// the containing message itself (for late unfurls); linked channels and DMs are
// never fetched, previews come only from what Slack attached to this event.
export async function buildSlackInboxItem(input: SlackIngestInput): Promise<SlackInboxItem> {
  return (await buildSlackInboxItemWithLatePreview(input)).item;
}

export async function buildSlackInboxItemWithLatePreview(input: SlackIngestInput): Promise<SlackInboxBuildResult> {
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const profiles = input.profiles ?? new SlackProfileResolver();
  const { client, event } = input;
  const teamId = slackEventTeamId(input.envelope, event);

  const [userProfile, channelProfile, text, permalink, attachments] = await Promise.all([
    profiles.user({ client, teamId, userId: event.user }),
    profiles.conversation({ channelId: event.channel, client, teamId }),
    profiles.displayText({ client, teamId, text: event.text }),
    slackPermalink(event, client, warn),
    slackFastUnfurlAttachments(event, client, warn),
  ]);

  const item = normalizeSlackMessage({
    ...(attachments ? { attachments } : {}),
    ...(input.attentionSuggestion ? { attentionSuggestion: input.attentionSuggestion } : {}),
    ...(channelProfile?.name ? { channelName: channelProfile.name } : {}),
    envelope: input.envelope,
    event,
    ...(permalink ? { permalink } : {}),
    text,
    ...(userProfile ? { userProfile } : {}),
  });

  if (attachmentsHaveSlackMessagePreviews(attachments)) return { item };

  return {
    item,
    latePreview: async (queuedItem) => {
      const delayedAttachments = await waitForSlackMessagePreviewAttachments({
        channelId: event.channel,
        client,
        messageTs: event.ts,
        text: event.text,
        warn,
      });
      const previews = slackMessagePreviewsFromAttachments(delayedAttachments);
      if (!previews.length) return undefined;
      return { ...queuedItem, previews };
    },
  };
}

async function slackPermalink(
  event: RoutableSlackMessage,
  client: WebClient,
  warn: (message: string) => void,
): Promise<string | undefined> {
  try {
    const response = await client.chat.getPermalink({
      channel: event.channel,
      message_ts: event.ts,
    });
    return response.permalink;
  } catch (error) {
    warn(`Slack permalink lookup failed for ${event.channel}/${event.ts}: ${errorMessage(error)}`);
    return undefined;
  }
}

// Unfurl attachments for the containing message: prefer what the realtime event
// carried; otherwise do one immediate re-read of the containing message. The
// delayed retry ladder runs after enqueue.
async function slackFastUnfurlAttachments(
  event: RoutableSlackMessage,
  client: WebClient,
  warn: (message: string) => void,
): Promise<unknown[] | undefined> {
  return event.attachments?.length
    ? event.attachments
    : slackMessageAttachments({
      channelId: event.channel,
      client,
      messageTs: event.ts,
      text: event.text,
      warn,
    });
}
