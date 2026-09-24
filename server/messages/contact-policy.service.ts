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

/**
 * `listed`: a recipient or mention is on the do-not-contact list (final).
 * `unverified`: the check could not establish who would receive the message,
 * so it failed closed. That is a lookup failure, not a do-not-contact match.
 * `config`: the host policy itself is unreadable or invalid.
 */
export type ContactPolicyRefusalKind = 'listed' | 'unverified' | 'config';

export class ContactPolicyRefusal extends Error {
  override readonly name = 'ContactPolicyRefusal';

  constructor(message: string, readonly kind: ContactPolicyRefusalKind = 'listed') {
    super(message);
  }
}

type Refusal = { kind: ContactPolicyRefusalKind; message: string };

const FAILURE_KIND: Record<ContactPolicyRefusalKind, string> = {
  listed: 'do-not-contact',
  unverified: 'contact-unverified',
  config: 'contact-policy-config',
};

/** A tool-layer constraint, not a sandbox against direct filesystem/Slack access. */
export async function assertSlackContactAllowed(input: ContactPolicyInput): Promise<void> {
  const refusal = await refusalReason(input);
  if (!refusal) return;
  await activityServiceForAgent(input.agentId).record({
    type: 'tool.call.failed',
    payload: {
      tool: input.tool,
      channel: input.channelId,
      status: 'failed',
      failureKind: FAILURE_KIND[refusal.kind],
      error: refusal.message,
    },
  });
  throw new ContactPolicyRefusal(refusal.message, refusal.kind);
}

async function refusalReason(input: ContactPolicyInput): Promise<Refusal | undefined> {
  let blocked: string[];
  try {
    const config = await serverConfigStore.read();
    if (!input.teamId) return unresolved(input.channelId, 'which Slack workspace is sending');
    blocked = config.doNotContact?.[input.teamId] ?? [];
  } catch {
    // Do not expose config contents or silently weaken an unreadable policy.
    return {
      kind: 'config',
      message: 'Not sent. The do-not-contact configuration could not be read or is invalid. Ask your human owner to repair the host configuration before sending.',
    };
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
      let conversation = await directory.getConversation(input.channelId);
      if (conversation && !conversation.userId && input.channelId.startsWith('D')) {
        // A cached D entry can be fresh yet lack its counterpart (e.g. written
        // from a sparse conversations.open). Ask Slack once before failing closed.
        conversation = (await directory.getConversationForCurrentBot(input.channelId)) ?? conversation;
      }
      if (!conversation) return unresolved(input.channelId, 'the conversation (Slack did not return it; the ID may be wrong or not visible to this bot)');
      if (conversation.isMpim) {
        recipientIds = await directory.getConversationMemberIds(input.channelId);
        if (recipientIds.length === 0) return unresolved(input.channelId, 'the group DM membership');
      } else if (conversation.isIm || input.channelId.startsWith('D')) {
        if (!conversation.userId) return unresolved(input.channelId, 'the DM recipient');
        recipientIds = [conversation.userId];
      } else if (conversation.isMpim !== false) {
        return unresolved(input.channelId, 'whether the private conversation is a group DM');
      }
    }
  } catch (error) {
    return unresolved(input.channelId, 'the DM recipient or group DM membership', slackErrorCode(error));
  }

  const userId = blocked.find((id) => recipientIds.includes(id) || slackEventMentionsUserId(input.content, id));
  if (!userId) return undefined;
  const user = await directory.getUser(userId).catch(() => undefined);
  const name = user?.displayName?.trim() || user?.realName?.trim() || user?.name?.trim();
  const person = name ? `${name} (${userId})` : userId;
  return {
    kind: 'listed',
    message: `Not sent. ${person} is on this workspace's do-not-contact list: they asked never to receive messages from agents. Do not DM or @mention them, do not try another agent or channel to reach them. If something needs to reach them, hand it to your human owner.`,
  };
}

/**
 * Fail closed, but say what actually happened: agents otherwise read a lookup
 * failure as "this person asked not to be contacted" and stop reaching them.
 */
function unresolved(channelId: string, subject: string, slackError?: string): Refusal {
  const cause = slackError ? ` (Slack: ${slackError})` : '';
  return {
    kind: 'unverified',
    message: `Not sent. Could not verify ${subject} for ${channelId}${cause}, and sends are held while a do-not-contact list is active. This is a lookup failure, not a do-not-contact match: it does not mean the recipient is on the list. Check that the channel ID is complete and correct, then retry. If the ID is correct and this keeps failing, tell your human owner.`,
  };
}

function slackErrorCode(error: unknown): string | undefined {
  const code = (error as { data?: { error?: unknown } } | undefined)?.data?.error;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : undefined;
}
