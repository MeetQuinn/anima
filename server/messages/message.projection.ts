import type { Activity } from '../../shared/activity.js';
import type {
  AgentMessageFile,
  AgentMessagePreview,
  AgentMessageRecord,
} from '../../shared/messages.js';
import type {
  ChoiceResponseInboxItem,
  FeishuInboxItem,
  FeishuOnboardingInboxItem,
  InboxItem,
  OnboardingInboxItem,
  SlackInboxItem,
} from '../../shared/inbox.js';

export function messageFromInboxItem(item: InboxItem): AgentMessageRecord | undefined {
  if (item.kind === 'slack') return slackInboxMessage(item);
  if (item.kind === 'feishu') return feishuInboxMessage(item);
  if (item.kind === 'reminder') {
    return {
      actor: 'Reminder',
      direction: 'in',
      kind: 'reminder',
      messageId: messageIdForInboxItem(item),
      reminderId: item.reminderId,
      ...(item.title ? { reminderTitle: item.title } : {}),
      source: { id: item.id, kind: 'inbox' },
      text: item.title ? `Reminder fired: ${item.title}` : 'Reminder fired',
      timestamp: item.receivedAt,
    };
  }
  if (item.kind === 'onboarding') return onboardingMessage(item);
  if (item.kind === 'feishu_onboarding') return feishuOnboardingMessage(item);
  if (item.kind === 'choice_response') return choiceResponseMessage(item);
  // memory_coherence deliberately does NOT project into the message ledger.
  // The memory-coherence scheduler's activity gate treats "a ledger entry
  // newer than the last pass" as meaningful activity; if a pass wrote a
  // ledger entry, every pass would justify the next one and the schedule
  // would never go quiet. See hasMeaningfulActivitySinceLastMemoryPass in
  // memory-coherence-scheduler.ts before adding projections here.
  return undefined;
}

export function messageFromActivity(activity: Activity): AgentMessageRecord | undefined {
  if (activity.type !== 'external.effect.completed' && activity.type !== 'tool.call.completed') return undefined;
  const payload = activity.payload ?? {};
  const tool = stringField(payload, 'tool');
  const effect = stringField(payload, 'effect');

  if (
    tool === 'anima.message.send' ||
    tool === 'anima.message.update' ||
    effect === 'slack.message.send' ||
    effect === 'slack.message.update' ||
    effect === 'feishu.message.send'
  ) {
    return baseOutboxMessage(activity, payload, {
      isEdit: tool === 'anima.message.update' || effect === 'slack.message.update',
      kind: 'message',
      messageTs: stringField(payload, 'ts') ?? stringField(payload, 'targetTs') ?? stringField(payload, 'messageId'),
      text: stringField(payload, 'text') ?? '',
    });
  }

  if (tool === 'anima.file.send' || effect === 'slack.file.send') {
    const files = uploadFiles(payload['uploads']);
    const caption = stringField(payload, 'caption') ?? '';
    const text = [caption, files.length ? `Files: ${files.map((file) => file.filename).join(', ')}` : 'Files uploaded']
      .filter(Boolean)
      .join('\n');
    return baseOutboxMessage(activity, payload, {
      files,
      kind: 'file',
      text,
    });
  }

  if (tool === 'anima.message.react' || effect === 'slack.reaction') {
    const action = stringField(payload, 'action') === 'removed' ? 'removed' : 'added';
    const name = stringField(payload, 'name') ?? '';
    return baseOutboxMessage(activity, payload, {
      kind: 'reaction',
      messageTs: stringField(payload, 'targetTs') ?? stringField(payload, 'ts'),
      reaction: {
        action,
        name,
        ...(payload['noop'] === true ? { noop: true } : {}),
      },
      text: `Reaction ${action}: :${name || 'unknown'}:`,
    });
  }

  return undefined;
}

export function messageIdForInboxItem(item: InboxItem): string {
  return `msg_inbox:${item.id}`;
}

export function messageIdForActivity(activity: Activity): string {
  return `msg_activity:${activity.activityId}`;
}

function slackInboxMessage(item: SlackInboxItem): AgentMessageRecord {
  return {
    actor: slackActorLabel(item),
    actorDisplayName: item.actor?.displayName,
    actorHandle: item.actor?.handle,
    actorUserId: item.actor?.userId,
    channelId: item.channelId,
    ...(item.channelName ? { channelName: item.channelName } : {}),
    direction: 'in',
    ...(item.files?.length ? { files: item.files.map((file) => ({
      filename: file.name,
      fileId: file.id,
      mimetype: file.mimetype,
      sizeBytes: file.sizeBytes,
    })) } : {}),
    kind: 'message',
    messageId: messageIdForInboxItem(item),
    messageTs: item.messageTs,
    ...(item.permalink ? { permalink: item.permalink } : {}),
    ...(item.previews?.length ? { previews: item.previews.map(slackPreviewMessage) } : {}),
    source: { id: item.id, kind: 'inbox' },
    text: item.text,
    ...(item.threadTs ? { threadTs: item.threadTs } : {}),
    timestamp: item.receivedAt,
  };
}

function feishuInboxMessage(item: FeishuInboxItem): AgentMessageRecord {
  return {
    actor: feishuActorLabel(item),
    actorDisplayName: item.actor?.displayName,
    actorUserId: item.actor?.openId ?? item.actor?.userId ?? item.actor?.unionId,
    channelDisplayName: feishuChatDisplayName(item),
    channelId: item.chatId,
    channelKind: item.chatType,
    direction: 'in',
    ...(item.files?.length ? { files: item.files.map((file) => ({
      filename: file.name,
      fileId: file.id,
      mimetype: file.mimetype,
      sizeBytes: file.sizeBytes,
    })) } : {}),
    kind: 'message',
    messageId: messageIdForInboxItem(item),
    messageTs: item.messageId,
    platform: 'feishu',
    source: { id: item.id, kind: 'inbox' },
    text: item.text,
    ...(item.threadId ? { threadTs: item.threadId } : {}),
    timestamp: item.receivedAt,
  };
}

function onboardingMessage(item: OnboardingInboxItem): AgentMessageRecord {
  return {
    actor: onboardingActorLabel(item),
    actorDisplayName: item.operator.displayName,
    actorHandle: item.operator.handle,
    actorUserId: item.operator.slackUserId,
    channelId: item.channelId,
    direction: 'in',
    kind: 'onboarding',
    messageId: messageIdForInboxItem(item),
    source: { id: item.id, kind: 'inbox' },
    text: item.text,
    timestamp: item.receivedAt,
  };
}

function feishuOnboardingMessage(item: FeishuOnboardingInboxItem): AgentMessageRecord {
  return {
    actor: 'Feishu owner',
    actorUserId: item.owner.openId,
    channelDisplayName: 'Feishu owner',
    channelKind: item.target.receiveIdType,
    direction: 'in',
    kind: 'onboarding',
    messageId: messageIdForInboxItem(item),
    platform: 'feishu',
    source: { id: item.id, kind: 'inbox' },
    text: item.text,
    timestamp: item.receivedAt,
  };
}

function choiceResponseMessage(item: ChoiceResponseInboxItem): AgentMessageRecord {
  return {
    actor: choiceActorLabel(item),
    actorDisplayName: item.answeredBy.displayName,
    actorHandle: item.answeredBy.handle,
    actorUserId: item.answeredBy.slackUserId,
    channelId: item.channelId,
    ...(item.channelName ? { channelName: item.channelName } : {}),
    direction: 'in',
    kind: 'choice_response',
    messageId: messageIdForInboxItem(item),
    messageTs: item.messageTs,
    optionLabel: item.optionLabel,
    question: item.question,
    source: { id: item.id, kind: 'inbox' },
    text: `Selected: ${item.optionLabel}\nQuestion: ${item.question}`,
    threadTs: item.threadTs,
    timestamp: item.receivedAt,
  };
}

function baseOutboxMessage(
  activity: Activity,
  payload: Record<string, unknown>,
  entry: Pick<AgentMessageRecord, 'kind' | 'text'> & Partial<AgentMessageRecord>,
): AgentMessageRecord {
  return {
    channelId: stringField(payload, 'channel'),
    channelDisplayName: stringField(payload, 'channelDisplayName'),
    channelKind: stringField(payload, 'channelKind'),
    channelName: stringField(payload, 'channelName'),
    direction: 'out',
    dmHandle: stringField(payload, 'dmHandle'),
    dmUserId: stringField(payload, 'dmUserId'),
    messageId: messageIdForActivity(activity),
    messageTs: entry.messageTs,
    permalink: stringField(payload, 'permalink'),
    platform: stringField(payload, 'platform'),
    source: { id: activity.activityId, kind: 'activity' },
    threadTs: stringField(payload, 'threadTs'),
    timestamp: activity.createdAt,
    ...entry,
  };
}

function slackActorLabel(item: SlackInboxItem): string {
  const actor = item.actor;
  const handle = actor?.handle?.replace(/^@/, '');
  if (handle) {
    const name = actor?.displayName ?? actor?.realName;
    return name && name !== handle ? `${name} (@${handle})` : `@${handle}`;
  }
  return actor?.displayName ?? actor?.realName ?? actor?.userId ?? 'Unknown user';
}

function slackPreviewMessage(preview: NonNullable<SlackInboxItem['previews']>[number]): AgentMessagePreview {
  return {
    platform: 'slack',
    text: preview.text,
    type: 'message_unfurl',
    ...(preview.authorId ? { authorId: preview.authorId } : {}),
    ...(preview.authorName ? { authorName: preview.authorName } : {}),
    ...(preview.authorSubname ? { authorSubname: preview.authorSubname } : {}),
    ...(preview.channelId ? { channelId: preview.channelId } : {}),
    ...(preview.fromUrl ? { fromUrl: preview.fromUrl } : {}),
    ...(preview.isPrivate ? { isPrivate: true } : {}),
    ...(preview.messageTs ? { messageTs: preview.messageTs } : {}),
  };
}

function feishuActorLabel(item: FeishuInboxItem): string {
  return item.actor?.displayName
    ?? item.actor?.openId
    ?? item.actor?.userId
    ?? item.actor?.unionId
    ?? 'Unknown Feishu user';
}

function feishuChatDisplayName(item: FeishuInboxItem): string {
  if (item.chatName) return item.chatName;
  return item.chatType === 'p2p' ? 'Feishu DM' : `Feishu ${item.chatType}`;
}

function onboardingActorLabel(item: OnboardingInboxItem): string {
  const handle = item.operator.handle?.replace(/^@/, '');
  if (handle) return `${item.operator.displayName} (@${handle})`;
  return item.operator.displayName || item.operator.slackUserId;
}

function choiceActorLabel(item: ChoiceResponseInboxItem): string {
  const handle = item.answeredBy.handle?.replace(/^@/, '');
  if (handle) {
    const name = item.answeredBy.displayName;
    return name && name !== handle ? `${name} (@${handle})` : `@${handle}`;
  }
  return item.answeredBy.displayName ?? item.answeredBy.slackUserId;
}

function uploadFiles(raw: unknown): AgentMessageFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const filename = stringField(record, 'filename');
    if (!filename) return [];
    return [{
      filename,
      ...(stringField(record, 'fileId') ? { fileId: stringField(record, 'fileId') } : {}),
      ...(stringField(record, 'mimetype') ? { mimetype: stringField(record, 'mimetype') } : {}),
      ...(stringField(record, 'permalink') ? { permalink: stringField(record, 'permalink') } : {}),
      ...(typeof record['sizeBytes'] === 'number' ? { sizeBytes: record['sizeBytes'] } : {}),
      ...(stringField(record, 'thumb360') ? { thumb360: stringField(record, 'thumb360') } : {}),
      ...(stringField(record, 'thumb720') ? { thumb720: stringField(record, 'thumb720') } : {}),
    }];
  });
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
