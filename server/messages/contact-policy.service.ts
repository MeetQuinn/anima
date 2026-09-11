import type { WebClient } from '@slack/web-api';

import { activityServiceForAgent } from '../activities/activity.service.js';
import { slackEventMentionsUserId, type SlackMessageTextInput } from '../slack/message-text.js';
import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';
import { serverConfigStore } from '../storage/schema/server.store.js';

type ContactPolicyInput = {
  agentId: string;
  teamId?: string;
  channelId: string;
  dmUserId?: string;
  client: WebClient;
  content: SlackMessageTextInput;
  tool: 'anima.message.send' | 'anima.message.update' | 'anima.ask' | 'anima.file.send';
};

export class ContactPolicyRefusal extends Error {
  override readonly name = 'ContactPolicyRefusal';
}

/** A tool-layer constraint, not a sandbox against direct filesystem/Slack access. */
export async function assertSlackContactAllowed(input: ContactPolicyInput): Promise<void> {
  const reason = await refusalReason(input);
  if (!reason) return;
  await activityServiceForAgent(input.agentId).record({
    type: 'tool.call.failed',
    payload: {
      tool: input.tool,
      channel: input.channelId,
      status: 'failed',
      failureKind: 'do-not-contact',
      error: reason,
    },
  });
  throw new ContactPolicyRefusal(reason);
}

async function refusalReason(input: ContactPolicyInput): Promise<string | undefined> {
  let blocked: string[];
  try {
    const config = await serverConfigStore.read();
    if (!input.teamId) return unresolved('the sending Slack workspace');
    blocked = config.doNotContact?.[input.teamId] ?? [];
  } catch {
    // Do not expose config contents or silently weaken an unreadable policy.
    return 'Not sent. The do-not-contact configuration could not be read or is invalid. Ask your human owner to repair the host configuration before sending.';
  }
  if (blocked.length === 0) return undefined;

  const directory = new SlackWorkspaceDirectoryService({ client: input.client, teamId: input.teamId });
  let recipientIds: string[] = [];
  try {
    if (input.dmUserId) {
      recipientIds = [input.dmUserId];
    } else if (input.channelId.startsWith('D') || input.channelId.startsWith('G')) {
      // Raw D ids lack a counterpart; G ids can be private channels OR group DMs.
      // A display-label lookup's best-effort fallback is not an authorization fact.
      const conversation = await directory.getConversation(input.channelId);
      if (!conversation) return unresolved('the Slack conversation');
      if (conversation.isMpim) {
        recipientIds = await directory.getConversationMemberIds(input.channelId);
        if (recipientIds.length === 0) return unresolved('the group DM membership');
      } else if (conversation.isIm || input.channelId.startsWith('D')) {
        if (!conversation.userId) return unresolved('the DM recipient');
        recipientIds = [conversation.userId];
      } else if (conversation.isMpim !== false) {
        return unresolved('whether the private conversation is a group DM');
      }
    }
  } catch {
    return unresolved('the DM recipient or group DM membership');
  }

  const userId = blocked.find((id) => recipientIds.includes(id) || slackEventMentionsUserId(input.content, id));
  if (!userId) return undefined;
  const user = await directory.getUser(userId).catch(() => undefined);
  const name = user?.displayName?.trim() || user?.realName?.trim() || user?.name?.trim();
  const person = name ? `${name} (${userId})` : userId;
  return `Not sent. ${person} is on this workspace's do-not-contact list: they asked never to receive messages from agents. Do not DM or @mention them, do not try another agent or channel to reach them. If something needs to reach them, hand it to your human owner.`;
}

function unresolved(subject: string): string {
  return `Not sent. An active do-not-contact policy could not verify ${subject}. Ask your human owner to resolve this before sending; do not try another route.`;
}
