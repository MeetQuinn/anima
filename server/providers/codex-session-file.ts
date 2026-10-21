import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { forEachFileLine } from '../file-lines.js';
import { CodexSessionTurnScanner } from './codex-events.js';

export function codexSessionsRoot(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(codexHome, 'sessions');
}

export async function findCodexSessionFile(root: string, threadId: string): Promise<string | undefined> {
  const stack: Array<{ depth: number; path: string }> = [{ depth: 0, path: root }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await readdir(current.path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        return path;
      }
      if (entry.isDirectory() && current.depth < 4) stack.push({ depth: current.depth + 1, path });
    }
  }
  return undefined;
}

/**
 * Scans the rollout for one turn, starting at byte `offset`. The rollout only
 * grows and a long thread can reach hundreds of megabytes, so this reads from
 * the offset instead of loading the whole file. A file now shorter than the
 * offset is rescanned from the start.
 */
export async function scanCodexSessionFile(
  path: string,
  offset: number,
  turnId: string,
): Promise<CodexSessionTurnScanner> {
  const scanner = new CodexSessionTurnScanner(turnId);
  // The writer may still be appending the last line; an incomplete one fails
  // to parse and is skipped.
  await forEachFileLine(path, offset, (line, lineOffset) => {
    scanner.push(line.toString('utf8'), lineOffset);
    return scanner.complete;
  });
  return scanner;
}
