// API contract types for the agent communication ledger.
// `messages` is the long-lived inbox/outbox view. Runtime wake queue remains
// the active work queue, and activity remains the audit/debug log.

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

export interface AgentMessagePreview {
  authorId?: string;
  authorName?: string;
  authorSubname?: string;
  channelId?: string;
  fromUrl?: string;
  isPrivate?: boolean;
  messageTs?: string;
  platform: 'slack';
  text: string;
  type: 'message_unfurl';
}

export interface AgentMessageRecord {
  actor?: string;
  // Inbound sender's Slack avatar (image_72), resolved best-effort at read time
  // in the /messages route. Absent when the lookup is unavailable (left
  // workspace, no photo, lookup failed); the UI falls back to an initial.
  actorAvatarUrl?: string;
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
  previews?: AgentMessagePreview[];
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

// Channels tab: Slack channels + DMs with local message history. This is a
// conversation-history view, not a current Slack membership inventory: silent
// adds with no messages are absent, and historical channels remain visible if
// the local ledger contains them. Slack only in v1.
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
  // Deprecated: the Channels tab no longer performs a Slack membership lookup.
  // Kept optional so older clients can tolerate responses from older runtimes.
  membershipPartial?: boolean;
}
