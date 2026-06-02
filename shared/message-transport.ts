// Shared transport contract types. Runtime adapters map platform-specific
// protocol objects into these neutral references before provider execution.

export type MessageTransportKind = 'slack' | 'feishu' | 'lark' | 'dingtalk';

export type TransportConversationKind = 'channel' | 'dm' | 'group' | 'thread';
export type TransportConversationVisibility = 'private' | 'public';

export interface TransportConversationRef {
  conversationId: string;
  displayName?: string;
  kind: TransportConversationKind;
  platform: MessageTransportKind;
  visibility?: TransportConversationVisibility;
  workspaceId: string;
}

export interface TransportMessageRef {
  conversationId: string;
  messageId: string;
  platform: MessageTransportKind;
  rootMessageId?: string;
  threadId?: string;
  workspaceId: string;
}

export interface TransportActor {
  displayName?: string;
  handle?: string;
  realName?: string;
  timezone?: {
    label?: string;
    name: string;
    offsetSeconds?: number;
  };
  userId: string;
}

export interface TransportFileMeta {
  downloadError?: string;
  id: string;
  mimetype: string;
  name: string;
  sizeBytes: number;
}
