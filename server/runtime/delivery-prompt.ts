import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
import { DEFAULT_MEMORY_COHERENCE_CONSOLIDATION_THRESHOLD_BYTES } from '../../shared/server-settings.js';
import {
  slackSurfaceDisplayRef,
  slackSurfaceForEvent,
} from '../inbox/slack-events.js';
import { slackDisplayLabel } from '../slack/slack.helper.js';
import {
  envelopeTime,
  formatUserLocalTime,
  renderEnvelope,
} from '../messages/envelope.js';
import type { Reminder } from '../../shared/reminder.js';
import {
  providerCrashRetryNote,
  RUNTIME_RESTART_CONTINUATION_NOTE,
} from './delivery-notes.js';

export interface CodeAgentPromptContext {
  memoryCoherence?: {
    consolidationThresholdBytes?: number;
    homePath?: string;
  };
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
 *   <file id="F-img" name="screenshot.png" mimetype="image/png" size_bytes="4096" />
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
    return buildRuntimeRestartContinuationDeliveryPrompt({
      itemId: event.id,
      time: event.handling.startedAt ?? event.receivedAt,
    });
  }
  if (event.kind === 'reminder') return buildReminderDeliveryPrompt(event, context);
  if (event.kind === 'memory_coherence') return buildMemoryCoherenceDeliveryPrompt(event, context.memoryCoherence);
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
    envelope: renderEnvelope([
      { key: 'platform', value: 'slack' },
      { key: 'channel', value: event.channelId },
      { key: 'time', value: envelopeTime(event.receivedAt) },
      { key: 'user_id', value: event.operator.slackUserId },
    ]),
    text: event.text,
  });
}

function buildFeishuOnboardingDeliveryPrompt(event: FeishuOnboardingInboxItem): string {
  return buildOnboardingDeliveryPrompt({
    envelope: renderEnvelope([
      { key: 'platform', value: 'feishu' },
      { key: 'channel', value: event.target.receiveId },
      { key: 'receive_id_type', value: event.target.receiveIdType },
      { key: 'time', value: envelopeTime(event.receivedAt) },
      { key: 'user_id', value: event.owner.openId },
    ]),
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
    input.attentionSuggestion,
  ].filter(Boolean).join('\n\n');
}

function buildChoiceResponseDeliveryPrompt(event: ChoiceResponseInboxItem): string {
  const actor = readableSlackActor(event.answeredBy);
  const envelope = renderEnvelope([
    { key: 'ask_id', value: event.askId },
    { key: 'channel', value: event.channelId },
    { key: 'thread_ts', value: event.threadTs },
    { key: 'message_ts', value: event.messageTs },
    { key: 'wake', value: 'ask_answered' },
    { key: 'time', value: envelopeTime(event.receivedAt) },
    { key: 'user_id', value: event.answeredBy.slackUserId },
  ]);
  return `Choice response:

${envelope}
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
  const envelope = renderEnvelope([
    { key: 'reminder_id', value: reminder.reminderId },
    { key: 'time', value: envelopeTime(scheduledDeliveryTime(event)) },
    { key: 'scheduled', value: envelopeTime(event.scheduledAt ?? event.receivedAt) },
  ]);

  return `Scheduled reminder:

${envelope} ${reminder.title}

Instructions:
${reminder.instructions}${provenance}`;
}

// Delivery time for scheduled wakes: the moment the runtime claimed the item
// (so a wake queued behind a busy turn shows its real delay), falling back to
// enqueue time for items rendered before claim.
function scheduledDeliveryTime(event: MemoryCoherenceInboxItem | ReminderInboxItem): string {
  return event.handling.startedAt ?? event.receivedAt;
}

function reminderOriginEnvelope(provenance: NonNullable<Reminder['provenance']>): string {
  return renderEnvelope([
    { key: 'channel_id', value: provenance.channelId },
    { key: 'thread_ts', value: provenance.threadTs },
    { key: 'message_ts', value: provenance.messageTs },
  ]);
}

function buildMemoryCoherenceDeliveryPrompt(
  event: MemoryCoherenceInboxItem,
  context: CodeAgentPromptContext['memoryCoherence'] = {},
): string {
  const envelope = renderEnvelope([
    { key: 'time', value: envelopeTime(scheduledDeliveryTime(event)) },
    { key: 'scheduled', value: envelopeTime(event.scheduledSlotAt) },
    { key: 'slot', value: event.scheduledSlotLabel },
  ]);
  const thresholdBytes =
    context.consolidationThresholdBytes ?? DEFAULT_MEMORY_COHERENCE_CONSOLIDATION_THRESHOLD_BYTES;
  const sizeBytes = memoryFileSizeBytes(context.homePath);
  return `Memory coherence system wake:

${envelope}

${memoryCoherenceBody({ sizeBytes, thresholdBytes })}`;
}

function memoryFileSizeBytes(homePath: string | undefined): number | undefined {
  if (!homePath) return undefined;
  try {
    return readFileSync(join(homePath, 'MEMORY.md')).byteLength;
  } catch {
    return undefined;
  }
}

function memoryCoherenceBody(input: {
  sizeBytes: number | undefined;
  thresholdBytes: number;
}): string {
  if (input.sizeBytes !== undefined && input.sizeBytes > input.thresholdBytes) {
    return memoryCoherenceConsolidationBody(input.sizeBytes, input.thresholdBytes);
  }
  return memoryCoherenceMaintenanceBody(input.sizeBytes);
}

function memoryCoherenceMaintenanceBody(sizeBytes: number | undefined): string {
  const opening = sizeBytes === undefined
    ? 'You are running your scheduled memory pass.'
    : `You are running your scheduled memory pass. Your \`MEMORY.md\` is currently ${formatMemorySize(sizeBytes)}.`;
  return [
    opening,
    '',
    'Read `MEMORY.md` as if you had just recovered from a context reset: it is the first thing the recovered you would see. What reads as noise? What open obligation is missing? Which recorded fact no longer matches the world? Fix what you find; if your notes record friction from a real recovery since the last pass, fix those spots first.',
    '',
    'If it all reads clean and current, leaving it alone is the right call. Do not churn to look busy.',
  ].join('\n');
}

function memoryCoherenceConsolidationBody(sizeBytes: number, thresholdBytes: number): string {
  return [
    `You are running your scheduled memory pass. Your \`MEMORY.md\` is currently ${formatMemorySize(sizeBytes)}, above the ${formatMemorySize(thresholdBytes)} consolidation threshold: this pass is structural consolidation, not routine upkeep.`,
    '',
    'Read `MEMORY.md` as if you had just recovered from a context reset, and keep a line only if the recovering you needs it to take over correctly; everything else becomes a pointer into your `notes/`. Work in this order: first copy the full current `MEMORY.md` verbatim into a `notes/` archive file, so nothing can be lost. Then restructure: demote closed work to one-line pointers, merge duplicates, correct stale facts, keep open obligations sharp. If your notes record friction from a real recovery, fix those spots first.',
    '',
    'Do not delete anything that has not landed in `notes/` first. If the size turns out to be genuinely open work rather than leftovers, trimming little is a legitimate outcome.',
  ].join('\n');
}

function formatMemorySize(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function buildRuntimeRestartContinuationDeliveryPrompt(input: {
  itemId: string;
  time: string;
}): string {
  return [
    'Runtime restart continuation:',
    '',
    renderEnvelope([
      { key: 'item', value: input.itemId },
      { key: 'time', value: envelopeTime(input.time) },
    ]),
    '',
    RUNTIME_RESTART_CONTINUATION_NOTE,
  ].join('\n');
}

export function buildProviderCrashRetryDeliveryPrompt(input: {
  attempt: number;
  itemId?: string;
  maxRetries: number;
  previousError: string;
  time: string;
}): string {
  return [
    'Provider crash retry:',
    '',
    renderEnvelope([
      { key: 'item', value: input.itemId },
      { key: 'retry', value: `${input.attempt}/${input.maxRetries}` },
      { key: 'time', value: envelopeTime(input.time) },
    ]),
    '',
    `Previous error: ${input.previousError}`,
    '',
    providerCrashRetryNote(),
  ].join('\n');
}

function messageEnvelope(event: SlackInboxItem): string {
  const surface = slackSurfaceForEvent(event);
  const { actor } = event;
  const displayRef = slackSurfaceDisplayRef(surface);
  return renderEnvelope([
    { key: 'channel', value: displayRef },
    { key: 'channel_id', value: displayRef === surface.channelId ? undefined : surface.channelId },
    { key: 'thread_ts', value: surface.threadTs },
    { key: 'message_ts', value: event.messageTs },
    { key: 'wake', value: event.wakeReason },
    { key: 'time', value: envelopeTime(event.receivedAt) },
    { key: 'user_id', value: actor?.userId },
    { key: 'user_local_time', value: actor?.timezone ? formatUserLocalTime(event.receivedAt, actor.timezone) : undefined },
    { key: 'user_tz', value: actor?.timezone?.name },
  ]);
}

function feishuMessageEnvelope(event: FeishuInboxItem): string {
  return renderEnvelope([
    { key: 'platform', value: 'feishu' },
    { key: 'chat', value: event.chatType },
    { key: 'chat_id', value: event.chatId },
    { key: 'chat_name', value: event.chatName, quoted: true },
    { key: 'thread_id', value: event.threadId },
    { key: 'message_id', value: event.messageId },
    { key: 'wake', value: event.wakeReason },
    { key: 'time', value: envelopeTime(event.receivedAt) },
    { key: 'user_id', value: event.actor?.openId ?? event.actor?.userId },
  ]);
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
