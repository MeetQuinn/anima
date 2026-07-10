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
  files?: AgentMessagePreviewFile[];
  fromUrl?: string;
  isPrivate?: boolean;
  messageTs?: string;
  platform: 'slack';
  text: string;
  type: 'message_unfurl';
}

export interface AgentMessagePreviewFile {
  id: string;
  mimetype: string;
  name: string;
  permalink?: string;
  sizeBytes: number;
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

// One limit policy for paged history reads (message ledger and activity feed):
// default 100, clamped to [1, 500]. Previously duplicated per-service.
export function normalizeHistoryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(1, Math.trunc(limit as number)), 500);
}

// Channels tab: Slack channels + DMs with recent local message history, plus
// active Slack channel subscriptions. This is not a current Slack membership
// inventory; quiet channels without local history appear only when subscribed.
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
}
