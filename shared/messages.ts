// API contract types for the agent communication ledger.
// `messages` is the long-lived inbox/outbox view. Runtime inbox remains the
// work queue, and activity remains the audit/debug log.

export type AgentMessageDirection = 'in' | 'out';

export type AgentMessageKind =
  | 'choice_response'
  | 'file'
  | 'message'
  | 'onboarding'
  | 'reaction'
  | 'reminder';

export interface AgentMessageFile {
  fileId?: string;
  filename: string;
  mimetype?: string;
  permalink?: string;
  sizeBytes?: number;
  thumb360?: string;
  thumb720?: string;
}

export interface AgentMessageReaction {
  action: 'added' | 'removed';
  name: string;
  noop?: boolean;
}

export interface AgentMessageSource {
  id: string;
  kind: 'activity' | 'inbox';
}

export interface AgentMessageRecord {
  actor?: string;
  actorDisplayName?: string;
  actorHandle?: string;
  actorUserId?: string;
  channelDisplayName?: string;
  channelId?: string;
  channelKind?: string;
  channelName?: string;
  direction: AgentMessageDirection;
  dmHandle?: string;
  dmUserId?: string;
  files?: AgentMessageFile[];
  isEdit?: boolean;
  kind: AgentMessageKind;
  messageId: string;
  messageTs?: string;
  optionLabel?: string;
  permalink?: string;
  platform?: string;
  question?: string;
  reaction?: AgentMessageReaction;
  reminderId?: string;
  reminderTitle?: string;
  source: AgentMessageSource;
  text: string;
  threadTs?: string;
  timestamp: string;
}

export interface AgentMessageHistoryPage {
  entries: AgentMessageRecord[];
  nextCursor?: string | null;
}

// Channels tab: the channels + DMs an agent is a member of. Channel membership
// is real (`is_member` from Slack), not message-derived; DMs are folded from
// message history since a 1:1 conversation has no Slack "membership" concept.
// Slack only in v1.
export type AgentChannelKind = 'channel' | 'dm';

export interface AgentChannelSummary {
  id: string;
  name?: string;
  platform: 'slack';
  kind: AgentChannelKind;
  status: 'following' | 'muted';
  lastActivityAt?: string;
  lastPostedAt?: string;
  // DM only: the counterpart's Slack avatar (image_72), best-effort. Absent when
  // the lookup is unavailable; the UI falls back to an initial placeholder.
  avatarUrl?: string;
}

export interface AgentChannelListResponse {
  channels: AgentChannelSummary[];
  // True when the authoritative Slack membership lookup failed, so `channels`
  // is derived only from subscription + message history and may be missing
  // silent member channels. The UI surfaces this as a "list may be incomplete"
  // signal rather than silently under-reporting. Absent/false on the happy path.
  membershipPartial?: boolean;
}
