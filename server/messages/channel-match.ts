import type { AgentMessageRecord } from '../../shared/messages.js';

// Shared channel matching for message history queries. Used by both the
// keyword search path and the channel-scoped list path so the Channels detail
// pane and the search tool agree on what "this channel" means. Matches a
// message against a channel term by id, name, display name, or (for DMs) the
// counterpart handle / user id, after normalizing away leading #/@ and the
// "DM with @" prefix the UI renders.

export function normalizeChannelSearchTerm(value: string): string {
  return value.trim().toLowerCase().replace(/^[@#]/, '').replace(/^dm with @/i, '');
}

export function messageMatchesChannel(entry: AgentMessageRecord, channel: string): boolean {
  const needle = normalizeChannelSearchTerm(channel);
  if (!needle) return true;
  const candidates = [
    entry.channelId,
    entry.channelName,
    entry.channelDisplayName,
    entry.dmHandle,
    entry.dmUserId,
  ];
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const normalized = normalizeChannelSearchTerm(candidate);
    return normalized === needle || candidate.trim().toLowerCase() === channel.trim().toLowerCase();
  });
}
