/**
 * Shared mid-turn follow-up policy for ACP adapters (Grok, Kimi, OpenCode).
 *
 * Compatible follow-ups land on the same ACP session. If a `session/prompt` is
 * already in flight, Anima cancels it first so the follow-up starts immediately
 * instead of waiting for a natural `end_turn`. Cancelled-prompt assistant chunks
 * are rolled back so they do not leak into the final Slack reply.
 *
 * Session methods, permissions, model selection, and activity mapping stay in
 * each adapter — this module only owns the interrupt + text-isolation contract.
 */

export interface AcpFollowupTurn {
  acceptingFollowups: boolean;
  followups: string[];
  text: string[];
}

export interface AcpFollowupTurnWithSignal extends AcpFollowupTurn {
  input: { signal?: AbortSignal };
}

/** Operator-facing acceptance text for appendToActiveRun. */
export function acpFollowupAppliedText(providerLabel: string): string {
  return `${providerLabel} follow-up applied (interrupts active prompt)`;
}

/**
 * Queue a follow-up and interrupt the in-flight prompt when needed.
 * Returns false when the turn is gone or no longer accepting follow-ups.
 */
export function appendAcpFollowupPrompt(input: {
  cancelSession: (sessionId: string) => void;
  prompt: string;
  promptInFlight: boolean;
  sessionId: string | undefined;
  turn: AcpFollowupTurn | undefined;
}): boolean {
  const turn = input.turn;
  if (!turn?.acceptingFollowups) return false;
  turn.followups.push(input.prompt);
  if (input.promptInFlight && input.sessionId) {
    input.cancelSession(input.sessionId);
  }
  return true;
}

/**
 * Drain the primary prompt then any mid-turn follow-ups serially.
 * Mid-turn cancel settles the in-flight RPC so the next prompt can start.
 */
export async function drainAcpTurnQueue(input: {
  firstPrompt: string;
  runOnePrompt: (prompt: string) => Promise<void>;
  turn: AcpFollowupTurnWithSignal;
}): Promise<void> {
  let next: string | undefined = input.firstPrompt;
  while (next !== undefined && !input.turn.input.signal?.aborted) {
    await input.runOnePrompt(next);
    next =
      input.turn.followups.length > 0
        ? input.turn.followups.shift()
        : undefined;
  }
  input.turn.acceptingFollowups = false;
}

/** Run a session/prompt while marking the controller prompt-in-flight. */
export async function withAcpPromptInFlight<T>(
  setInFlight: (value: boolean) => void,
  run: () => Promise<T>,
): Promise<T> {
  setInFlight(true);
  try {
    return await run();
  } finally {
    setInFlight(false);
  }
}

/**
 * Drop assistant chunks produced by a cancelled mid-turn prompt.
 * Returns true when the checkpoint was applied.
 */
export function rollbackCancelledAcpPromptText(
  turn: { text: string[] },
  textCheckpoint: number,
  stopReason: string | undefined,
): boolean {
  if (stopReason !== "cancelled") return false;
  turn.text.length = textCheckpoint;
  return true;
}

/** Drop partial assistant text after a failed in-flight prompt. */
export function discardAcpPromptPartialText(
  turn: { text: string[] },
  textCheckpoint: number,
): void {
  turn.text.length = textCheckpoint;
}
