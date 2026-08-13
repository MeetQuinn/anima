// Runtime seal for memory-coherence wakes (product boundary after 0.1.23 Grant
// regression). Prompt text is defense-in-depth only; enforcement lives here.
//
// Invariants enforced in this cut:
// 1. Isolated context — never resume a long-lived business provider session.
// 2. Capabilities denied — Anima side-effect tools fail closed when the active
//    inbox item is memory_coherence (messaging, external effects, reminders…).
// 3. Provider tool deny list expanded for Claude (Bash/Task/web/subagent class).
// 4. Fail-closed tool path — denial throws; no silent allow.
// 5. Obligations may still be written to MEMORY.md / notes/ (allowed paths for
//    the model via normal file tools; Anima tools that write elsewhere are denied).
//
// Residual: native Write/Edit can still target absolute paths outside notes when
// the model bypasses the prompt; Bash is disallowed on Claude. Path-level Write
// interception is a follow-up if product requires it before re-enable.

import type { InboxItem } from '../../shared/inbox.js';
import { wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';

/** Env flag visible to the provider child and anima CLI for seal-aware launch. */
export const ANIMA_MEMORY_COHERENCE_SEAL_ENV = 'ANIMA_MEMORY_COHERENCE_SEAL';

export class MemoryCoherenceSealError extends Error {
  readonly code = 'memory_coherence_seal_denied';
  constructor(action: string) {
    super(
      `memory coherence seal: ${action} is denied during a maintenance-only pass `
        + '(only MEMORY.md and notes/ may be edited; no messages, external services, '
        + 'subagents, reminders, or config changes)',
    );
    this.name = 'MemoryCoherenceSealError';
  }
}

export function isMemoryCoherenceItem(item: InboxItem | undefined): boolean {
  return item?.kind === 'memory_coherence';
}

/**
 * True when this process is running a sealed memory-coherence turn.
 * Prefers the live queue item over the env flag alone (flag can be forged;
 * queue kind is the authority when available).
 */
export async function isActiveMemoryCoherenceSeal(agentId: string): Promise<boolean> {
  const itemId = process.env.ANIMA_INBOX_ITEM_ID?.trim();
  if (!itemId) return process.env[ANIMA_MEMORY_COHERENCE_SEAL_ENV] === '1';
  try {
    const item = await wakeQueueServiceForAgent(agentId).find(itemId);
    if (item) return isMemoryCoherenceItem(item);
  } catch {
    // Fall through to env flag if queue is unreadable.
  }
  return process.env[ANIMA_MEMORY_COHERENCE_SEAL_ENV] === '1';
}

/** Fail-closed gate for any side-effecting Anima tool during a memory pass. */
export async function assertMemoryCoherenceSealAllowsSideEffect(
  agentId: string,
  action: string,
): Promise<void> {
  if (await isActiveMemoryCoherenceSeal(agentId)) {
    throw new MemoryCoherenceSealError(action);
  }
}

/**
 * Provider-native tools that must be unavailable during a sealed pass on Claude.
 * Complements Anima CLI denials (messages, reminders, etc.).
 */
export const MEMORY_COHERENCE_CLAUDE_DISALLOWED_TOOLS = [
  'Bash',
  'Task',
  'Agent',
  'WebSearch',
  'WebFetch',
  'NotebookEdit',
  'BashOutput',
  'KillShell',
] as const;
