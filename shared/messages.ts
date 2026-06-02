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
  source: AgentMessageSource;
  text: string;
  threadTs?: string;
  timestamp: string;
}

export interface AgentMessageHistoryPage {
  entries: AgentMessageRecord[];
  nextCursor?: string | null;
}
