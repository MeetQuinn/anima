import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CodexSessionTurnScanner } from './codex-events.js';

const READ_CHUNK_BYTES = 256 * 1024;

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
 * grows and a long thread can reach hundreds of megabytes, so this reads it in
 * chunks from the offset instead of loading the whole file into one string.
 */
export async function scanCodexSessionFile(
  path: string,
  offset: number,
  turnId: string,
): Promise<CodexSessionTurnScanner> {
  const scanner = new CodexSessionTurnScanner(turnId);
  const handle = await open(path, 'r');
  try {
    // A file shorter than the offset is not the file the offset came from.
    let position = offset <= (await handle.stat()).size ? offset : 0;
    let lineOffset = position;
    let pending: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (!scanner.complete) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      let start = 0;
      // A 0x0a byte never occurs inside a multi-byte UTF-8 sequence.
      for (let end = data.indexOf(0x0a); end !== -1 && !scanner.complete; end = data.indexOf(0x0a, start)) {
        const segment = data.subarray(start, end);
        const line = pending.length === 0 ? segment.toString('utf8') : Buffer.concat([...pending, segment]).toString('utf8');
        scanner.push(line, lineOffset);
        pending = [];
        start = end + 1;
        lineOffset = position + start;
      }
      if (start < bytesRead) pending.push(Buffer.from(data.subarray(start)));
      position += bytesRead;
    }
    // The writer may still be appending the last line; an incomplete one fails
    // to parse and is skipped.
    if (!scanner.complete && pending.length > 0) scanner.push(Buffer.concat(pending).toString('utf8'), lineOffset);
    return scanner;
  } finally {
    await handle.close();
  }
}
