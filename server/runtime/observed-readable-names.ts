// The observed-conversation journal keeps Slack's raw text and each sender's
// user id. The wake trigger shows `Name (@handle)` and readable mentions; the
// context rows rendered next to it should read the same way, or agents look
// the ids up one at a time. Lookups go through the shared workspace directory
// cache and are best-effort and bounded: a failed or slow lookup leaves the
// rows exactly as journaled.

import type { WebClient } from '@slack/web-api';

import type { AgentConfig } from '../../shared/agent-config.js';
import type { InboxItem } from '../../shared/inbox.js';
import { createAgentSlackDeadlineWebClient } from '../agents/agent-slack.service.js';
import { AgentService } from '../agents/agent.service.js';
import { errorMessage } from '../ids.js';
import { SlackProfileResolver, type SlackUserProfile } from '../slack/profiles.js';
import {
  channelLabel,
  decodeSlackEntities,
  extractSlackChannelMentionIds,
  extractSlackUserMentionIds,
  replaceSlackChannelMentions,
  replaceSlackUserMentions,
  slackDisplayLabel,
  slackMentionLabel,
} from '../slack/slack.helper.js';
import type { ObservedConversationEntry } from '../storage/schema/observed-conversation.store.js';

/** A journal row as shown to an agent: readable text, plus the sender's name when known. */
export type ReadableObservedEntry<T extends ObservedConversationEntry = ObservedConversationEntry> = T & {
  senderLabel?: string;
};

export type ObservedNameReader = <T extends ObservedConversationEntry>(
  entries: T[],
) => Promise<Array<ReadableObservedEntry<T>>>;

const READABLE_NAMES_TIMEOUT_MS = 3_000;

export function observedNameReader(input: {
  /** A client whose requests stop when `signal` aborts, so no lookup outlives the deadline. */
  client: (signal: AbortSignal, requestTimeoutMs: number) => WebClient;
  profiles?: SlackProfileResolver;
  teamId: string;
  timeoutMs?: number;
}): ObservedNameReader {
  const profiles = input.profiles ?? new SlackProfileResolver();
  const { teamId } = input;
  const timeoutMs = input.timeoutMs ?? READABLE_NAMES_TIMEOUT_MS;
  return async <T extends ObservedConversationEntry>(entries: T[]): Promise<Array<ReadableObservedEntry<T>>> => {
    if (entries.length === 0) return entries;
    // One deadline covers every request this call starts, and it keeps running
    // after the call answers: a stale directory entry is answered from cache
    // while its refresh goes on in the background, queued behind the SDK's
    // concurrency limit. At the deadline, in-flight requests are cancelled
    // and queued ones fail without being sent, so a CLI process can exit.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    deadline.unref?.();
    const timedOut = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    const client = input.client(controller.signal, timeoutMs);

    const userIds = new Set<string>();
    const channelIds = new Set<string>();
    for (const entry of entries) {
      if (entry.userId) userIds.add(entry.userId);
      for (const id of extractSlackUserMentionIds(entry.text)) userIds.add(id);
      for (const id of extractSlackChannelMentionIds(entry.text)) channelIds.add(id);
    }

    const lookup = Promise.all([
      Promise.all([...userIds].map(async (userId) => (
        [userId, await profiles.user({ client, teamId, userId })] as const
      ))),
      Promise.all([...channelIds].map(async (channelId) => (
        [channelId, await profiles.conversation({ channelId, client, teamId })] as const
      ))),
    ]);
    const resolved = await Promise.race([lookup.catch(() => undefined), timedOut]);
    if (!resolved) return entries;

    const [users, channels] = resolved;
    const senderLabels = new Map<string, string>();
    const userMentions = new Map<string, string>();
    for (const [userId, profile] of users) {
      userMentions.set(userId, slackMentionLabel({ ...profile, userId }));
      const label = senderLabel(userId, profile);
      if (label) senderLabels.set(userId, label);
    }
    const channelMentions = new Map<string, string>();
    for (const [channelId, profile] of channels) {
      channelMentions.set(channelId, channelLabel(profile?.name ?? channelId));
    }

    return entries.map((entry) => {
      const label = entry.userId ? senderLabels.get(entry.userId) : undefined;
      return {
        ...entry,
        text: decodeSlackEntities(
          replaceSlackChannelMentions(replaceSlackUserMentions(entry.text, userMentions), channelMentions),
        ),
        ...(label ? { senderLabel: label } : {}),
      };
    });
  };
}

/** The reader for an agent's own Slack app; none when it has no bot token. */
export function observedNameReaderForAgent(agent: AgentConfig, teamId: string): ObservedNameReader | undefined {
  if (!agent.slack.botToken) return undefined;
  return observedNameReader({
    client: (signal, requestTimeoutMs) => createAgentSlackDeadlineWebClient(agent, signal, requestTimeoutMs),
    teamId: agent.slack.teamId || teamId,
  });
}

/** `prepareCursorDelivery` input for a wake: a reader for Slack wakes, nothing otherwise. */
export async function readNamesFor(agentId: string, item: InboxItem): Promise<{ readNames?: ObservedNameReader }> {
  if (item.kind !== 'slack') return {};
  try {
    const readNames = observedNameReaderForAgent(await new AgentService(agentId).getConfig(), item.teamId);
    return readNames ? { readNames } : {};
  } catch (error) {
    console.warn(`readable names unavailable for agent=${agentId}: ${errorMessage(error)}`);
    return {};
  }
}

// Same shape as the wake trigger's sender. A profile with neither a handle nor
// a name beyond the id adds nothing over the id the row already shows.
function senderLabel(userId: string, profile: SlackUserProfile | undefined): string | undefined {
  if (!profile) return undefined;
  const displayName = profile.displayName && profile.displayName !== userId ? profile.displayName : undefined;
  if (!displayName && !profile.handle) return undefined;
  return slackDisplayLabel({ displayName, handle: profile.handle, userId });
}
