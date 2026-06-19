// API contract types for inbox items. Consumed by server and web.

import { z } from 'zod';

export const InboxItemStatus = z.enum(['queued', 'running', 'completed', 'failed']);
export type InboxItemStatus = z.infer<typeof InboxItemStatus>;

export const InboxItemHandling = z.object({
  appendedAt: z.string().optional(),
  appendedToItemId: z.string().optional(),
  completedAt: z.string().optional(),
  createdAt: z.string(),
  drainRequestedAt: z.string().optional(),
  drainTimeoutMs: z.number().int().nonnegative().optional(),
  failedAt: z.string().optional(),
  queuedAt: z.string().optional(),
  resumeReason: z.enum(['runtime_restart']).optional(),
  settledAt: z.string().optional(),
  startedAt: z.string().optional(),
  status: InboxItemStatus,
  stopRequestedAt: z.string().optional(),
  updatedAt: z.string(),
  workerId: z.string().optional(),
});

export type InboxItemHandling = z.infer<typeof InboxItemHandling>;

export const SlackInboxActor = z.object({
  displayName: z.string().optional(),
  handle: z.string().optional(),
  realName: z.string().optional(),
  timezone: z.object({
    label: z.string().optional(),
    name: z.string(),
    offsetSeconds: z.number().optional(),
  }).optional(),
  userId: z.string().optional(),
});

export type SlackInboxActor = z.infer<typeof SlackInboxActor>;

export const InboxFileMeta = z.object({
  downloadError: z.string().optional(),
  id: z.string(),
  mimetype: z.string(),
  name: z.string(),
  sizeBytes: z.number(),
});

export type InboxFileMeta = z.infer<typeof InboxFileMeta>;

export const SlackFileMeta = InboxFileMeta;
export type SlackFileMeta = InboxFileMeta;

export const FeishuInboxActor = z.object({
  displayName: z.string().optional(),
  openId: z.string().optional(),
  senderType: z.string().optional(),
  unionId: z.string().optional(),
  userId: z.string().optional(),
});

export type FeishuInboxActor = z.infer<typeof FeishuInboxActor>;

const InboxItemBase = z.object({
  handling: InboxItemHandling,
  id: z.string(),
  receivedAt: z.string(),
});

export const SlackInboxItem = InboxItemBase.extend({
  actor: SlackInboxActor.optional(),
  attentionSuggestion: z.string().optional(),
  channelId: z.string(),
  channelName: z.string().optional(),
  files: z.array(SlackFileMeta).optional(),
  kind: z.literal('slack'),
  messageTs: z.string(),
  permalink: z.string().optional(),
  teamId: z.string(),
  text: z.string(),
  threadTs: z.string().optional(),
});

export type SlackInboxItem = z.infer<typeof SlackInboxItem>;

export const FeishuQuotedMessage = z.object({
  actorLabel: z.string(),
  text: z.string(),
});
export type FeishuQuotedMessage = z.infer<typeof FeishuQuotedMessage>;

export const FeishuInboxItem = InboxItemBase.extend({
  actor: FeishuInboxActor.optional(),
  attentionSuggestion: z.string().optional(),
  appId: z.string().optional(),
  chatId: z.string(),
  chatName: z.string().optional(),
  chatType: z.string(),
  files: z.array(InboxFileMeta).optional(),
  kind: z.literal('feishu'),
  messageId: z.string(),
  parentId: z.string().optional(),
  quotedMessage: FeishuQuotedMessage.optional(),
  rawContent: z.string().optional(),
  rootId: z.string().optional(),
  tenantKey: z.string().optional(),
  text: z.string(),
  threadId: z.string().optional(),
});

export type FeishuInboxItem = z.infer<typeof FeishuInboxItem>;

export const FeishuOnboardingInboxItem = InboxItemBase.extend({
  kind: z.literal('feishu_onboarding'),
  owner: z.object({
    openId: z.string(),
    tenantBrand: z.enum(['feishu', 'lark']).optional(),
  }).strict(),
  target: z.object({
    platform: z.literal('feishu'),
    receiveId: z.string(),
    receiveIdType: z.literal('open_id'),
  }).strict(),
  text: z.string(),
});

export type FeishuOnboardingInboxItem = z.infer<typeof FeishuOnboardingInboxItem>;

export const ReminderInboxItem = InboxItemBase.extend({
  kind: z.literal('reminder'),
  reminderId: z.string(),
  title: z.string().optional(),
});

export type ReminderInboxItem = z.infer<typeof ReminderInboxItem>;

export const OnboardingInboxItem = InboxItemBase.extend({
  channelId: z.string(),
  kind: z.literal('onboarding'),
  operator: z.object({
    displayName: z.string(),
    handle: z.string().optional(),
    slackUserId: z.string(),
  }).strict(),
  teamId: z.string(),
  text: z.string(),
});

export type OnboardingInboxItem = z.infer<typeof OnboardingInboxItem>;

export const ChoiceResponseInboxItem = InboxItemBase.extend({
  answeredBy: z.object({
    displayName: z.string().optional(),
    handle: z.string().optional(),
    slackUserId: z.string(),
  }).strict(),
  askId: z.string(),
  channelId: z.string(),
  channelName: z.string().optional(),
  kind: z.literal('choice_response'),
  messageTs: z.string(),
  optionId: z.string(),
  optionLabel: z.string(),
  question: z.string(),
  teamId: z.string(),
  threadTs: z.string(),
});

export type ChoiceResponseInboxItem = z.infer<typeof ChoiceResponseInboxItem>;

export const InboxItemSchema = z.discriminatedUnion('kind', [
  SlackInboxItem,
  FeishuInboxItem,
  FeishuOnboardingInboxItem,
  ReminderInboxItem,
  OnboardingInboxItem,
  ChoiceResponseInboxItem,
]);

export type InboxItem = z.infer<typeof InboxItemSchema>;

export function isAppendedRunningInboxItem(item: InboxItem): boolean {
  return item.handling.status === 'running' && Boolean(item.handling.appendedToItemId);
}

export function isPrimaryRunningInboxItem(item: InboxItem): boolean {
  return item.handling.status === 'running' && !item.handling.appendedToItemId;
}
