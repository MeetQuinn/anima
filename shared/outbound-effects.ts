// Canonical classification of outbound conversational effects.
//
// Activity payloads describe outbound effects with two fields: `tool` (the
// anima.* tool that ran, e.g. `anima.message.send`) and `effect` (the
// platform-level effect it produced, e.g. `slack.message.send`). Before this
// module, the (tool, effect) → message/file/reaction decision was duplicated
// in three near-identical copies (server ledger projection + two web feed
// builders) that had drifted: feishu.message.update / feishu.reaction /
// feishu.file.send are real emitted effects but were only recognized via the
// tool field, so an effect-only payload was silently dropped.
//
// `slack.ask.post` classifies as `ask`: the posted question is agent-authored
// channel content, so it belongs in the message ledger ("the ledger holds
// everything conversational; the boundary excludes runtime bookkeeping, not
// agent-authored channel content"). Consumers decide what `ask` means for
// them: the server projects it into the ledger as an outbound message; the
// web activity feed leaves it to the generic step row (unchanged rendering).

export type OutboundEffectClassification =
  | { isEdit: boolean; kind: 'message' }
  | { kind: 'ask' }
  | { kind: 'file' }
  | { kind: 'reaction' };

const MESSAGE_TOOLS = new Set(['anima.message.send', 'anima.message.update']);
const MESSAGE_EFFECTS = new Set([
  'feishu.message.send',
  'feishu.message.update',
  'slack.message.send',
  'slack.message.update',
]);
const MESSAGE_EDIT_TOOL = 'anima.message.update';
const MESSAGE_EDIT_EFFECTS = new Set(['feishu.message.update', 'slack.message.update']);

const FILE_TOOL = 'anima.file.send';
const FILE_EFFECTS = new Set(['feishu.file.send', 'slack.file.send']);

const REACTION_TOOL = 'anima.message.react';
const REACTION_EFFECTS = new Set(['feishu.reaction', 'slack.reaction']);

const ASK_TOOL = 'anima.ask';
const ASK_EFFECTS = new Set(['slack.ask.post']);

/** True when a completed tool activity is a send-hold outcome, not a post. */
export function isHeldSendStatus(status: unknown): boolean {
  return status === 'held';
}

/**
 * Activity-tab copy for a held send. The delta is always conversation messages
 * that arrived while composing — never "files arrived" even when the held tool
 * was file send. "Nothing was sent" covers message/ask/file neutrally.
 */
export function heldSendActivityCopy(input: { deltaCount?: unknown }): string {
  const raw = input.deltaCount;
  const n =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.max(0, Math.floor(raw))
      : 0;
  const noun = n === 1 ? 'message' : 'messages';
  return `Send held: ${n} new ${noun} arrived while composing; nothing was sent.`;
}

export function classifyOutboundEffect(input: {
  effect?: string | undefined;
  /** When `held`, never classifies as an outbound post (ledger / feed). */
  status?: string | undefined;
  tool?: string | undefined;
}): OutboundEffectClassification | undefined {
  // Send-hold records a local tool.call.completed with status:held and no
  // external.effect / outbox row. Tool name alone would still match message /
  // file / ask — reject held first so every consumer stays aligned.
  if (isHeldSendStatus(input.status)) return undefined;
  const { effect, tool } = input;
  if ((tool && MESSAGE_TOOLS.has(tool)) || (effect && MESSAGE_EFFECTS.has(effect))) {
    return {
      isEdit: tool === MESSAGE_EDIT_TOOL || (effect !== undefined && MESSAGE_EDIT_EFFECTS.has(effect)),
      kind: 'message',
    };
  }
  if (tool === FILE_TOOL || (effect && FILE_EFFECTS.has(effect))) {
    return { kind: 'file' };
  }
  if (tool === REACTION_TOOL || (effect && REACTION_EFFECTS.has(effect))) {
    return { kind: 'reaction' };
  }
  if (tool === ASK_TOOL || (effect && ASK_EFFECTS.has(effect))) {
    return { kind: 'ask' };
  }
  return undefined;
}
