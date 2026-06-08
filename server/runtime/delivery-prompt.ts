import type {
  ChoiceResponseInboxItem,
  FeishuInboxItem,
  FeishuOnboardingInboxItem,
  FeishuQuotedMessage,
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
  if (event.kind === 'reminder') return buildReminderDeliveryPrompt(event, context);
  if (event.kind === 'choice_response') return buildChoiceResponseDeliveryPrompt(event);
  if (event.kind === 'onboarding') return buildSlackOnboardingDeliveryPrompt(event);
  if (event.kind === 'feishu_onboarding') return buildFeishuOnboardingDeliveryPrompt(event);
  if (event.kind === 'feishu') return buildFeishuMessageDeliveryPrompt(event);

  return buildSlackMessageDeliveryPrompt(event);
}

function buildSlackMessageDeliveryPrompt(event: SlackEvent): string {
  const envelope = `${messageEnvelope(event)} ${actorLabel(event)}: ${event.text}`;
  return buildDeliveryEventPrompt({
    attentionSuggestion: event.attentionSuggestion,
    envelope,
    files: event.files,
    title: 'New Slack message',
  });
}

function buildFeishuMessageDeliveryPrompt(event: FeishuInboxItem): string {
  const envelope = event.quotedMessage
    ? `${feishuMessageEnvelope(event)} ${feishuActorLabel(event)}:\n${formatFeishuQuotedMessage(event.quotedMessage)}\n${event.text}`
    : `${feishuMessageEnvelope(event)} ${feishuActorLabel(event)}: ${event.text}`;
  return buildDeliveryEventPrompt({
    attentionSuggestion: event.attentionSuggestion,
    envelope,
    files: event.files,
    title: 'New Feishu message',
  });
}

function formatFeishuQuotedMessage(message: FeishuQuotedMessage): string {
  return message.text
    .split(/\r?\n/)
    .map((line) => `> (quoted) ${message.actorLabel}: ${line}`)
    .join('\n');
}

function buildSlackOnboardingDeliveryPrompt(event: OnboardingInboxItem): string {
  return buildOnboardingDeliveryPrompt({
    envelope: `[owner=${readableOwnerLabel(event.operator)} channel=${event.channelId} time=${event.receivedAt}]`,
    text: event.text,
  });
}

function buildFeishuOnboardingDeliveryPrompt(event: FeishuOnboardingInboxItem): string {
  return buildOnboardingDeliveryPrompt({
    envelope: `[platform=feishu owner=feishu-owner channel=${event.target.receiveId} receive_id_type=${event.target.receiveIdType} time=${event.receivedAt}]`,
    text: event.text,
  });
}

function buildOnboardingDeliveryPrompt(input: {
  envelope: string;
  text: string;
}): string {
  return buildDeliveryEventPrompt({
    body: input.text,
    envelope: input.envelope,
    title: 'Agent onboarding',
  });
}

function buildDeliveryEventPrompt(input: {
  attentionSuggestion?: string;
  body?: string;
  envelope: string;
  files?: InboxFileMeta[];
  title: string;
}): string {
  const primary = `${input.title}:\n\n${[input.envelope, input.body].filter(Boolean).join('\n')}`;
  return [
    primary,
    formatAttachedFiles(input.files),
    input.attentionSuggestion ? `Attention suggestion:\n${input.attentionSuggestion}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildChoiceResponseDeliveryPrompt(event: ChoiceResponseInboxItem): string {
  const actor = readableChoiceActor(event.answeredBy);
  return `Choice response:

[ask_id=${event.askId} channel=${event.channelId} thread_ts=${event.threadTs} message_ts=${event.messageTs} time=${event.receivedAt} user_id=${event.answeredBy.slackUserId}]
${actor} selected: ${event.optionLabel}

Question:
${event.question}`;
}

function buildReminderDeliveryPrompt(
  event: ReminderInboxItem,
  context: CodeAgentPromptContext,
): string {
  const reminder = context.reminder?.reminderId === event.reminderId ? context.reminder : undefined;
  if (!reminder) throw new Error(`Reminder context not found: ${event.reminderId}`);
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
    'Continue the original task from the current files, conversation, and connected chat state.',
    'Do not repeat completed external side effects such as chat messages, file sends, or file edits; inspect state first if needed.',
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
  const chatNamePart = event.chatName ? ` chat_name=${quoteEnvelopeValue(event.chatName)}` : '';
  return `[platform=feishu chat=${event.chatType} chat_id=${event.chatId}${chatNamePart}${threadPart} message_id=${event.messageId} time=${event.receivedAt}${userPart}]`;
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

function quoteEnvelopeValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
