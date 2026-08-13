// Runtime seal for memory-coherence wakes (product boundary after 0.1.23 Grant
// regression). Prompt text is defense-in-depth only; enforcement lives here.
//
// Invariants:
// 1. Isolated context — never resume a long-lived business provider session.
// 2. Capabilities denied — Anima side-effect tools fail closed when the active
//    inbox item is memory_coherence (messaging, external effects, reminders…).
// 3. Path fence — native Write/Edit/MultiEdit allowed only for MEMORY.md and
//    notes/** under the agent home (Claude PreToolUse hook + settings).
// 4. Fail-closed tool path — denial throws / hook exit 2; no silent allow.
// 5. Obligations may still be written to MEMORY.md / notes/.

import { relative, resolve, sep } from 'node:path';

import type { InboxItem } from '../../shared/inbox.js';
import { wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';

/** Env flag visible to the provider child and anima CLI for seal-aware launch. */
export const ANIMA_MEMORY_COHERENCE_SEAL_ENV = 'ANIMA_MEMORY_COHERENCE_SEAL';
/** Agent home path for the write-fence hook (absolute). */
export const ANIMA_MEMORY_COHERENCE_HOME_ENV = 'ANIMA_MEMORY_COHERENCE_HOME';

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
 * Write/Edit/MultiEdit stay available but are path-fenced by the PreToolUse hook.
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

/**
 * Allowlist for native file writes during a sealed pass: only `MEMORY.md` and
 * anything under `notes/` inside the agent home. Deny by default (Iris product
 * boundary invariant 3). Paths are resolved; `notes/../x` cannot escape.
 */
export function isMemoryCoherenceAllowedWritePath(homePath: string, targetPath: string): boolean {
  if (!homePath.trim() || !targetPath.trim()) return false;
  const home = resolve(homePath);
  // Absolute targetPath ignores home; relative is resolved against home.
  const target = resolve(home, targetPath);
  const memoryMd = resolve(home, 'MEMORY.md');
  const notesRoot = resolve(home, 'notes');
  if (target === memoryMd) return true;
  if (target === notesRoot) return true;
  const rel = relative(notesRoot, target);
  // Inside notes/ when relative path is non-empty and does not escape (..)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('../');
}

/** Extract candidate write paths from a Claude PreToolUse payload. */
export function writePathsFromToolInput(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string[] {
  if (!toolInput) return [];
  const name = toolName.toLowerCase();
  // Path fence applies to file-mutating tools only.
  if (!['write', 'edit', 'multiedit', 'notebookedit'].includes(name)) return [];
  const paths: string[] = [];
  const single = toolInput.file_path ?? toolInput.filePath ?? toolInput.path;
  if (typeof single === 'string' && single.trim()) paths.push(single);
  const edits = toolInput.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue;
      const p = (edit as Record<string, unknown>).file_path
        ?? (edit as Record<string, unknown>).filePath
        ?? (edit as Record<string, unknown>).path;
      if (typeof p === 'string' && p.trim()) paths.push(p);
    }
  }
  return paths;
}

/**
 * Evaluate a PreToolUse payload for the write fence.
 * Returns `{ allow: true }` or `{ allow: false, reason }`.
 */
export function evaluateMemoryCoherenceWriteFence(input: {
  homePath: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
}): { allow: true } | { allow: false; reason: string } {
  const paths = writePathsFromToolInput(input.toolName, input.toolInput);
  // Non-file tools are not gated here (Bash/Task are disallowed separately).
  if (paths.length === 0) return { allow: true };
  for (const p of paths) {
    if (!isMemoryCoherenceAllowedWritePath(input.homePath, p)) {
      return {
        allow: false,
        reason:
          `memory coherence seal: write path denied (${p}); `
          + 'only MEMORY.md and notes/ under the agent home may be written',
      };
    }
  }
  return { allow: true };
}

