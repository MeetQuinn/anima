export const RUNTIME_RESTART_CONTINUATION_NOTE = [
  'Anima note: the runtime restarted while this task was in progress.',
  'Continue the same task from the current session; do not repeat completed external side effects.',
  'Check `anima outbox` for what you already sent and `anima inbox` for what arrived before re-sending anything.',
].join('\n');

export const DEFERRED_WAKE_RETRY_NOTE = [
  'Anima note: an operator clicked Retry now on a wake that was parked for a provider rate-limit reset.',
  'The original deferred item was invalidated so it will not run again when the reset time arrives.',
  'Handle the missed request now and reply on the original Slack surface below.',
  'Do not repeat completed external side effects; check `anima outbox` / conversation state before redoing anything.',
].join('\n');

export function providerCrashRetryNote(): string {
  return [
    'Anima note: the previous provider process crashed before completing this same item.',
    'Continue the original task from the current files, conversation, and connected chat state.',
    'Do not repeat completed external side effects such as chat messages, file sends, or file edits; check `anima outbox` for what already went out, and inspect files/state, before redoing anything.',
  ].join('\n');
}

export function providerTransientRetryNote(): string {
  return [
    'Anima note: the previous attempt at this same item stopped on a transient provider error (network, overload, or a safeguard false positive), so Anima is re-sending it on the same session.',
    'Continue the original task from the current files, conversation, and connected chat state.',
    'Do not repeat completed external side effects such as chat messages, file sends, or file edits; check `anima outbox` for what already went out, and inspect files/state, before redoing anything.',
  ].join('\n');
}

export function providerSessionRecoveryNote(): string {
  return [
    'Anima note: the previous provider session was corrupted, so Anima archived it and started a fresh session for this same item.',
    'Continue the original task from the current files, conversation, and connected chat state.',
    'Do not repeat completed external side effects such as chat messages, file sends, or file edits; check `anima outbox` for what already went out, and inspect files/state, before redoing anything.',
  ].join('\n');
}

export function slackChannelAttentionNote(channelId: string): string {
  const command = `anima subscription mute --channel ${channelId}`;
  return `Anima note: you've been reading channel ${channelId} without posting. If it is not relevant, mute it with \`${command}\`.`;
}

export function slackThreadAttentionNote(channelId: string, threadTs: string): string {
  const command = `anima subscription mute --channel ${channelId} --thread-ts ${threadTs}`;
  return `Anima note: you've been reading thread ${threadTs} in ${channelId} without posting. If it is not relevant, mute it with \`${command}\`.`;
}

export function feishuChatAttentionNote(chatId: string): string {
  const command = `anima subscription mute --chat-id ${chatId}`;
  return `Anima note: you've been reading Feishu chat ${chatId} without posting. If it is not relevant, mute it with \`${command}\`.`;
}
