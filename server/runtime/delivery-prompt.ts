import type {
  ChoiceResponseInboxItem,
  FeishuInboxItem,
  FeishuOnboardingInboxItem,
  FeishuQuotedMessage,
  InboxItem,
  InboxFileMeta,
  MemoryCoherenceInboxItem,
  OnboardingInboxItem,
  ReminderInboxItem,
  SlackInboxItem,
} from '../../shared/inbox.js';
import {
  slackSurfaceDisplayRef,
  slackSurfaceForEvent,
} from '../inbox/slack-events.js';
import { slackDisplayLabel } from '../slack/slack.helper.js';
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
 *   [reminder_id=reminder-test time=2026-05-18T17:00:00Z scheduled=2026-05-18T17:00:00Z] Follow up on deploy
 *
 *   Instructions:
 *   Check whether the deploy finished.
 *
 *   Scheduled from: [channel_id=C-team thread_ts=1770000020.000001 message_ts=1770000010.000001]
 */
export function buildCodeAgentDeliveryPrompt(event: InboxItem, context: CodeAgentPromptContext = {}): string {
  if (event.handling.resumeReason === 'runtime_restart') {
    return buildRuntimeRestartContinuationDeliveryPrompt();
  }
  if (event.kind === 'reminder') return buildReminderDeliveryPrompt(event, context);
  if (event.kind === 'memory_coherence') return buildMemoryCoherenceDeliveryPrompt(event);
  if (event.kind === 'choice_response') return buildChoiceResponseDeliveryPrompt(event);
  if (event.kind === 'onboarding') return buildSlackOnboardingDeliveryPrompt(event);
  if (event.kind === 'feishu_onboarding') return buildFeishuOnboardingDeliveryPrompt(event);
  if (event.kind === 'feishu') return buildFeishuMessageDeliveryPrompt(event);

  return buildSlackMessageDeliveryPrompt(event);
}

function buildSlackMessageDeliveryPrompt(event: SlackInboxItem): string {
  const envelope = `${messageEnvelope(event)} ${actorLabel(event)}: ${event.text}`;
  return buildDeliveryEventPrompt({
    attentionSuggestion: event.attentionSuggestion,
    body: formatSlackMessagePreviews(event.previews),
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
    envelope: `[owner=${readableSlackActor(event.operator)} channel=${event.channelId} time=${envelopeTime(event.receivedAt)}]`,
    text: event.text,
  });
}

function buildFeishuOnboardingDeliveryPrompt(event: FeishuOnboardingInboxItem): string {
  return buildOnboardingDeliveryPrompt({
    envelope: `[platform=feishu owner=feishu-owner channel=${event.target.receiveId} receive_id_type=${event.target.receiveIdType} time=${envelopeTime(event.receivedAt)}]`,
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
  const actor = readableSlackActor(event.answeredBy);
  return `Choice response:

[ask_id=${event.askId} channel=${event.channelId} thread_ts=${event.threadTs} message_ts=${event.messageTs} time=${envelopeTime(event.receivedAt)} user_id=${event.answeredBy.slackUserId}]
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
    ? `\n\nScheduled from: ${reminderOriginEnvelope(reminder.provenance)}`
    : '';

  return `Scheduled reminder:

[reminder_id=${reminder.reminderId} time=${envelopeTime(reminderDeliveryTime(event))} scheduled=${envelopeTime(event.receivedAt)}] ${reminder.title}

Instructions:
${reminder.instructions}${provenance}`;
}

function reminderDeliveryTime(event: ReminderInboxItem): string {
  return event.handling.startedAt ?? event.receivedAt;
}

function reminderOriginEnvelope(provenance: NonNullable<Reminder['provenance']>): string {
  const threadPart = provenance.threadTs ? ` thread_ts=${provenance.threadTs}` : '';
  return `[channel_id=${provenance.channelId}${threadPart} message_ts=${provenance.messageTs}]`;
}

function buildMemoryCoherenceDeliveryPrompt(event: MemoryCoherenceInboxItem): string {
  return `Memory coherence system wake:

[time=${envelopeTime(event.receivedAt)} scheduled_slot_at=${envelopeTime(event.scheduledSlotAt)} scheduled_slot=${event.scheduledSlotLabel}]

You are running your scheduled memory pass.

This is your scheduled moment to keep your durable memory in good shape: lean, accurate, and genuinely useful to the future you who will recover from it. Memory drifts over time. Duplication creeps in, facts go stale, detail piles up where a short pointer would do.

Use your judgment. Consolidate what is redundant, fix what is outdated, and move detail that no longer needs to live in \`MEMORY.md\` out to your \`notes/\` (just make sure it lands there before it leaves \`MEMORY.md\`, so nothing is lost). You know your own memory best. If it is already in good shape, leaving it alone is the right call. Do not churn to look busy.`;
}

export function buildRuntimeRestartContinuationDeliveryPrompt(): string {
  return [
    'Anima system message: runtime restarted while this task was in progress.',
    'Continue the same task from the current session; do not repeat completed external side effects.',
    'Check `anima outbox` for what you already sent (and `anima inbox` for what arrived) before re-sending anything.',
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
    'Do not repeat completed external side effects such as chat messages, file sends, or file edits; check `anima outbox` for what already went out, and inspect files/state, before redoing anything.',
  ].join('\n');
}

function messageEnvelope(event: SlackInboxItem): string {
  const surface = slackSurfaceForEvent(event);
  const { actor } = event;
  const displayRef = slackSurfaceDisplayRef(surface);
  const channelIdPart = displayRef === surface.channelId ? '' : ` channel_id=${surface.channelId}`;
  const threadPart = surface.threadTs ? ` thread_ts=${surface.threadTs}` : '';
  const wakePart = event.wakeReason ? ` wake=${event.wakeReason}` : '';
  const userPart = actor?.userId ? ` user_id=${actor.userId}` : '';
  const userTimePart = actor?.timezone ? ` user_local_time=${formatUserLocalTime(event.receivedAt, actor.timezone)} user_tz=${actor.timezone.name}` : '';

  return `[channel=${displayRef}${channelIdPart}${threadPart} message_ts=${event.messageTs}${wakePart} time=${envelopeTime(event.receivedAt)}${userPart}${userTimePart}]`;
}

function feishuMessageEnvelope(event: FeishuInboxItem): string {
  const threadPart = event.threadId ? ` thread_id=${event.threadId}` : '';
  const actorUserId = event.actor?.openId ?? event.actor?.userId;
  const userPart = actorUserId ? ` user_id=${actorUserId}` : '';
  const wakePart = event.wakeReason ? ` wake=${event.wakeReason}` : '';
  const chatNamePart = event.chatName ? ` chat_name=${quoteEnvelopeValue(event.chatName)}` : '';
  return `[platform=feishu chat=${event.chatType} chat_id=${event.chatId}${chatNamePart}${threadPart} message_id=${event.messageId}${wakePart} time=${envelopeTime(event.receivedAt)}${userPart}]`;
}

function actorLabel(event: SlackInboxItem): string {
  const { actor } = event;
  return slackDisplayLabel({
    displayName: actor?.displayName ?? actor?.realName,
    handle: actor?.handle,
    userId: actor?.userId,
  });
}

function feishuActorLabel(event: FeishuInboxItem): string {
  return event.actor?.displayName
    ?? event.actor?.openId
    ?? event.actor?.userId
    ?? event.actor?.unionId
    ?? '@unknown';
}

function readableSlackActor(actor: { displayName?: string; handle?: string; slackUserId: string }): string {
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

function formatSlackMessagePreviews(previews: SlackInboxItem['previews']): string {
  if (!previews?.length) return '';
  const rendered = previews.map((preview) => {
    const attrs = [
      'source="slack_unfurl"',
      preview.isPrivate ? 'private_preview="true"' : '',
      preview.authorName ? `author=${escapeAttr(preview.authorName)}` : '',
      preview.authorId ? `author_id=${escapeAttr(preview.authorId)}` : '',
      preview.channelId ? `channel_id=${escapeAttr(preview.channelId)}` : '',
      preview.messageTs ? `message_ts=${escapeAttr(preview.messageTs)}` : '',
      preview.fromUrl ? `url=${escapeAttr(preview.fromUrl)}` : '',
    ].filter(Boolean).join(' ');
    return `<preview ${attrs}>\n${preview.text}\n</preview>`;
  });
  return '<slack_message_previews>\n' + rendered.join('\n') + '\n</slack_message_previews>';
}

function formatAttachedFile(file: InboxFileMeta): string {
  const errorAttr = file.downloadError ? ` error=${escapeAttr(file.downloadError)}` : '';

  return `<file id=${escapeAttr(file.id)} name=${escapeAttr(file.name)} mimetype=${escapeAttr(file.mimetype)} size_bytes=${escapeAttr(String(file.sizeBytes))}${errorAttr} />`;
}

function normalizeHandle(handle: string | undefined): string | undefined {
  if (!handle) return undefined;
  return handle.startsWith('@') ? handle : `@${handle}`;
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

/** Envelope timestamps render at second granularity; sub-second precision is noise for reading context (message_ts carries exact identity). */
function envelopeTime(timestamp: string): string {
  return timestamp.replace(/\.\d{3}(?=Z$|[+-]\d{2}:\d{2}$)/, '');
}

function formatUserLocalTime(
  timestamp: string,
  timezone: NonNullable<NonNullable<SlackInboxItem['actor']>['timezone']>,
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
