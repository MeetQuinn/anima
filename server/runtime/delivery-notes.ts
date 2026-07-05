export const FOLLOWUP_NOTE = 'Anima note: this message arrived while you were mid-task. '
  + 'Finish or pause your current work as you judge best, but address it before the turn ends: '
  + 'an unanswered mid-turn message is a dropped one. '
  + 'If it is heavy and unrelated, record it as a task before this turn ends.';

export const RUNTIME_RESTART_CONTINUATION_NOTE = [
  'Anima note: the runtime restarted while this task was in progress.',
  'Continue the same task from the current session; do not repeat completed external side effects.',
  'Check `anima outbox` for what you already sent and `anima inbox` for what arrived before re-sending anything.',
].join('\n');

export function providerCrashRetryNote(): string {
  return [
    'Anima note: the previous provider process crashed before completing this same item.',
    'Continue the original task from the current files, conversation, and connected chat state.',
    'Do not repeat completed external side effects such as chat messages, file sends, or file edits; check `anima outbox` for what already went out, and inspect files/state, before redoing anything.',
  ].join('\n');
}
