import type {
  AgentMessageInboxItem,
  ChoiceResponseInboxItem,
  FeishuInboxItem,
  FeishuOnboardingInboxItem,
  InboxItem,
  InboxFileMeta,
  OnboardingInboxItem,
  ReminderInboxItem,
} from '../../shared/inbox.js';
import {
  slackSurfaceDisplayRef,
  slackSurfaceForEvent,
  type SlackEvent,
} from '../inbox/slack-events.js';
import type { Reminder } from '../../shared/reminder.js';

export interface CodeAgentPromptContext {
  reminder?: Reminder;
}

/**
 * Builds the user-facing delivery prompt that is sent to the code agent.
 *
 * Slack message (channel thread, with files):
 *   New Slack message:
 *
 *   [channel=#team channel_id=C-team thread_ts=1770000020.000001 message_ts=1770000010.000001 time=... user_id=U1 user_local_time=... user_tz=America/Los_Angeles] Alice (@alice): check this out
 *   <attached_files>
 *   <file id="F-img" name="screenshot.png" mimetype="image/png" size_bytes="4096" path="/tmp/anima/F-img/screenshot.png" />
 *   </attached_files>
 *
 * Scheduled reminder (with provenance):
 *   Scheduled reminder:
 *
 *   [reminder_id=reminder-test time=2026-05-18T17:00:00.000Z] Scheduled wake: Follow up on deploy
 *
 *   Instructions:
 *   Check whether the deploy finished.
 *
 *   Provenance:
 *   {
 *     "threadTs": "1770000020.000001",
 *     "channelId": "C-team"
 *   }
 */
export function buildCodeAgentDeliveryPrompt(event: InboxItem, context: CodeAgentPromptContext = {}): string {
  if (event.handling.resumeReason === 'runtime_restart') {
    return buildRuntimeRestartContinuationDeliveryPrompt();
  }
  if (event.kind === 'reminder') {
    return buildReminderDeliveryPrompt(event, context);
  }
  if (event.kind === 'onboarding') {
    return buildOnboardingDeliveryPrompt({
      channelId: event.channelId,
      ownerLabel: readableOwnerLabel(event.operator),
      receivedAt: event.receivedAt,
      text: event.text,
    });
  }
  if (event.kind === 'choice_response') {
    return buildChoiceResponseDeliveryPrompt(event);
  }
  if (event.kind === 'feishu_onboarding') {
    return buildFeishuOnboardingDeliveryPrompt(event);
  }
  if (event.kind === 'feishu') {
    return buildFeishuDeliveryPrompt(event);
  }
  if (event.kind === 'agent_message') {
    return buildAgentMessageDeliveryPrompt(event);
  }
  if (event.id.startsWith('agent-onboarding:')) {
    return buildLegacyOnboardingSlackDeliveryPrompt(event);
  }

  return buildSlackDeliveryPrompt(event);
}

function buildFeishuDeliveryPrompt(event: FeishuInboxItem): string {
  const envelope = `${feishuMessageEnvelope(event)} ${feishuActorLabel(event)}: ${event.text}`;
  return [
    `New Feishu message:\n\n${envelope}`,
    formatAttachedFiles(event.files),
    [
      'Reply target:',
      `Use \`anima message send --channel ${event.chatId}\` to post back to this Feishu chat.`,
      `Use \`anima message send --channel ${event.chatId} --thread-ts ${event.messageId}\` to reply in this message's topic.`,
      'Use `anima message send --channel <chat_id>` to send to an explicit Feishu chat.',
      'Feishu API access: use `FEISHU_TENANT_ACCESS_TOKEN`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_API_BASE_URL` from env when you need Feishu APIs. Do not print these values.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

function buildFeishuOnboardingDeliveryPrompt(event: FeishuOnboardingInboxItem): string {
  return `Agent onboarding:

[owner=feishu-owner channel=${event.target.receiveId} time=${event.receivedAt}]
${event.text}

Reply target:
Use \`anima message send --channel ${event.target.receiveId}\` to reply to your owner.`;
}

function buildAgentMessageDeliveryPrompt(event: AgentMessageInboxItem): string {
  const replyPart = event.replyTo ? ` reply_to=${event.replyTo}` : '';
  const envelope = `[platform=local from=${event.fromAgentId} name=${event.fromName} message_id=${event.id}${replyPart} time=${event.receivedAt}] ${event.fromName}: ${event.text}`;
  return [
    `New local agent message:\n\n${envelope}`,
    [
      'This is a local agent-to-agent message. It was not sent on any chat platform — it lives only in this Anima home and shows in the dashboard log.',
      'Reply target:',
      `Use \`anima relay send --to ${event.fromAgentId} --reply-to ${event.id}\` to reply to ${event.fromName}.`,
      'Use `anima relay list` to see which local agents you can reach.',
    ].join('\n'),
  ].join('\n\n');
}

function buildSlackDeliveryPrompt(event: SlackEvent): string {
  const envelope = `${messageEnvelope(event)} ${actorLabel(event)}: ${event.text}`;
  return [
    `New Slack message:\n\n${envelope}`,
    formatAttachedFiles(event.files),
    event.attentionSuggestion ? `Attention suggestion:\n${event.attentionSuggestion}` : '',
  ].filter(Boolean).join('\n');
}

function buildChoiceResponseDeliveryPrompt(event: ChoiceResponseInboxItem): string {
  const actor = readableChoiceActor(event.answeredBy);
  return `Choice response:

[ask_id=${event.askId} channel=${event.channelId} thread_ts=${event.threadTs} message_ts=${event.messageTs} time=${event.receivedAt} user_id=${event.answeredBy.slackUserId}]
${actor} selected: ${event.optionLabel}

Question:
${event.question}

Reply target:
Use \`anima message send --channel ${event.channelId} --thread-ts ${event.threadTs}\` to reply under the question.`;
}

function buildLegacyOnboardingSlackDeliveryPrompt(event: SlackEvent): string {
  const ownerLabel = event.actor?.userId ? `<@${event.actor.userId}>` : 'the owner';
  return buildOnboardingDeliveryPrompt({
    channelId: event.channelId,
    ownerLabel,
    receivedAt: event.receivedAt,
    text: event.text,
  });
}

function buildOnboardingDeliveryPrompt(input: {
  channelId: string;
  ownerLabel: string;
  receivedAt: string;
  text: string;
}): string {
  return `Agent onboarding:

[owner=${input.ownerLabel} channel=${input.channelId} time=${input.receivedAt}]
${input.text}

Reply target:
Use \`anima message send --channel ${input.channelId}\` to reply to ${input.ownerLabel}.`;
}

function buildReminderDeliveryPrompt(
  event: ReminderInboxItem,
  context: CodeAgentPromptContext,
): string {
  const reminder = context.reminder?.reminderId === event.reminderId ? context.reminder : undefined;
  if (!reminder) {
    return `Scheduled reminder:\n\n[reminder_id=${event.reminderId} time=${event.receivedAt}] Reminder fired.`;
  }
  const provenance = reminder.provenance
    ? `\n\nProvenance:\n${JSON.stringify(reminder.provenance, null, 2)}`
    : '';

  return `Scheduled reminder:

[reminder_id=${reminder.reminderId} time=${event.receivedAt}] Scheduled wake: ${reminder.title}

Instructions:
${reminder.instructions}${provenance}`;
}

export function buildRuntimeRestartContinuationDeliveryPrompt(): string {
  return [
    'Anima system message: runtime restarted while this task was in progress.',
    'Continue the same task from the current session; do not repeat completed external side effects.',
  ].join('\n');
}

export function buildProviderCrashRetryDeliveryPrompt(input: {
  attempt: number;
  maxRetries: number;
  previousError: string;
}): string {
  return [
    'Anima system note: the previous provider process crashed before completing this same item.',
    `This is retry ${input.attempt}/${input.maxRetries}.`,
    `Previous error: ${input.previousError}`,
    'Continue the original task from the current files, conversation, and Slack state.',
    'Do not repeat completed external side effects such as Slack messages, file sends, or file edits; inspect state first if needed.',
  ].join('\n');
}

function messageEnvelope(event: SlackEvent): string {
  const surface = slackSurfaceForEvent(event);
  const { actor } = event;
  const displayRef = slackSurfaceDisplayRef(surface);
  const channelIdPart = displayRef === surface.channelId ? '' : ` channel_id=${surface.channelId}`;
  const threadPart = surface.threadTs ? ` thread_ts=${surface.threadTs}` : '';
  const userPart = actor?.userId ? ` user_id=${actor.userId}` : '';
  const userTimePart = actor?.timezone ? ` user_local_time=${formatUserLocalTime(event.receivedAt, actor.timezone)} user_tz=${actor.timezone.name}` : '';

  return `[channel=${displayRef}${channelIdPart}${threadPart} message_ts=${event.messageTs} time=${event.receivedAt}${userPart}${userTimePart}]`;
}

function feishuMessageEnvelope(event: FeishuInboxItem): string {
  const threadPart = event.threadId ? ` thread_id=${event.threadId}` : '';
  const actorUserId = event.actor?.openId ?? event.actor?.userId;
  const userPart = actorUserId ? ` user_id=${actorUserId}` : '';
  return `[platform=feishu chat=${event.chatType} chat_id=${event.chatId}${threadPart} message_id=${event.messageId} time=${event.receivedAt}${userPart}]`;
}

function actorLabel(event: SlackEvent): string {
  const { actor } = event;
  const displayName = actor?.displayName ?? actor?.realName;
  const handle = normalizeHandle(actor?.handle);

  if (displayName && handle) {
    if (sameName(displayName, handle)) return handle;
    return `${displayName} (${handle})`;
  }
  return displayName ?? handle ?? (actor?.userId ? `@${actor.userId}` : '@unknown');
}

function feishuActorLabel(event: FeishuInboxItem): string {
  return event.actor?.displayName
    ?? event.actor?.openId
    ?? event.actor?.userId
    ?? event.actor?.unionId
    ?? '@unknown';
}

function readableOwnerLabel(owner: OnboardingInboxItem['operator']): string {
  const handle = normalizeHandle(owner.handle);
  const mention = `<@${owner.slackUserId}>`;
  if (owner.displayName && handle) return `${owner.displayName} (${handle}, ${mention})`;
  if (owner.displayName) return `${owner.displayName} (${mention})`;
  return handle ? `${handle} (${mention})` : mention;
}

function readableChoiceActor(actor: ChoiceResponseInboxItem['answeredBy']): string {
  const handle = normalizeHandle(actor.handle);
  const mention = `<@${actor.slackUserId}>`;
  if (actor.displayName && handle) return `${actor.displayName} (${handle}, ${mention})`;
  if (actor.displayName) return `${actor.displayName} (${mention})`;
  return handle ? `${handle} (${mention})` : mention;
}

function formatAttachedFiles(files: InboxFileMeta[] | undefined): string {
  if (!files?.length) return '';
  const rendered = files.map(formatAttachedFile);
  return '<attached_files>\n' + rendered.join('\n') + '\n</attached_files>';
}

function formatAttachedFile(file: InboxFileMeta): string {
  const errorAttr = file.downloadError ? ` error=${escapeAttr(file.downloadError)}` : '';

  return `<file id=${escapeAttr(file.id)} name=${escapeAttr(file.name)} mimetype=${escapeAttr(file.mimetype)} size_bytes=${escapeAttr(String(file.sizeBytes))}${errorAttr} />`;
}

function normalizeHandle(handle: string | undefined): string | undefined {
  if (!handle) return undefined;
  return handle.startsWith('@') ? handle : `@${handle}`;
}

function sameName(a: string, b: string): boolean {
  return a.trim().replace(/^@/, '').toLowerCase() === b.trim().replace(/^@/, '').toLowerCase();
}

function escapeAttr(value: string): string {
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `"${escaped}"`;
}

function formatUserLocalTime(
  timestamp: string,
  timezone: NonNullable<NonNullable<SlackEvent['actor']>['timezone']>,
): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return timestamp;
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: timezone.name,
    year: 'numeric',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const offset = typeof timezone.offsetSeconds === 'number' ? timezoneOffsetSuffix(timezone.offsetSeconds) : '';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}${offset}`;
}

function timezoneOffsetSuffix(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const absolute = Math.abs(offsetSeconds);
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor((absolute % 3600) / 60);
  return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
