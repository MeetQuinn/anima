import type { WebClient } from '@slack/web-api';

import { errorMessage } from '../ids.js';
import {
  attachmentsHaveSlackMessagePreviews,
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

// Turns one routable Slack event into a fully enriched inbox item: sender and
// channel profiles, readable mention text, permalink, unfurl previews, and file
// metadata. Every Slack lookup is best-effort — a failure degrades that field
// and never blocks the wake. Privacy boundary: the only message-content read is
// the containing message itself (for late unfurls); linked channels and DMs are
// never fetched, previews come only from what Slack attached to this event.
export async function buildSlackInboxItem(input: SlackIngestInput): Promise<SlackInboxItem> {
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const profiles = input.profiles ?? new SlackProfileResolver();
  const { client, event } = input;
  const teamId = slackEventTeamId(input.envelope, event);

  const userProfile = await profiles.user({ client, teamId, userId: event.user });
  const channelName = (await profiles.conversation({ channelId: event.channel, client, teamId }))?.name;
  const text = await profiles.displayText({ client, teamId, text: event.text });
  const permalink = await slackPermalink(event, client, warn);
  const attachments = await slackUnfurlAttachments(event, client, warn);

  return normalizeSlackMessage({
    ...(attachments ? { attachments } : {}),
    ...(input.attentionSuggestion ? { attentionSuggestion: input.attentionSuggestion } : {}),
    ...(channelName ? { channelName } : {}),
    envelope: input.envelope,
    event,
    ...(permalink ? { permalink } : {}),
    text,
    ...(userProfile ? { userProfile } : {}),
  });
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
// carried; otherwise re-read the containing message, waiting briefly because
// Slack attaches unfurls asynchronously.
async function slackUnfurlAttachments(
  event: RoutableSlackMessage,
  client: WebClient,
  warn: (message: string) => void,
): Promise<unknown[] | undefined> {
  let attachments = event.attachments?.length
    ? event.attachments
    : await slackMessageAttachments({
      channelId: event.channel,
      client,
      messageTs: event.ts,
      text: event.text,
      warn,
    });
  if (!attachmentsHaveSlackMessagePreviews(attachments)) {
    const delayedAttachments = await waitForSlackMessagePreviewAttachments({
      channelId: event.channel,
      client,
      messageTs: event.ts,
      text: event.text,
      warn,
    });
    if (delayedAttachments?.length) attachments = delayedAttachments;
  }
  return attachments;
}
