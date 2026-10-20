import { open } from 'node:fs/promises';

const FIRST_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;

export interface LogTailOptions {
  /** Bytes read from the end on the first try. Each retry reads four times as many. */
  firstReadBytes?: number;
  /** The most bytes read from the end of the file. */
  maxReadBytes?: number;
}

/**
 * The last `limit` non-empty lines of a log file, or none if it cannot be
 * read. Reads only the end of the file, growing the read until it holds
 * `limit` lines, reaches the start of the file, or reaches `maxReadBytes`.
 * Up to that cap, the result is the same as splitting the whole file. At the
 * cap, it holds only the lines that start in the file's last `maxReadBytes`.
 */
export async function readLastLogLines(path: string, limit: number, options: LogTailOptions = {}): Promise<string[]> {
  const maxReadBytes = options.maxReadBytes ?? MAX_READ_BYTES;
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    let span = Math.min(options.firstReadBytes ?? FIRST_READ_BYTES, maxReadBytes);
    for (;;) {
      const start = Math.max(0, size - span);
      // Read from one byte earlier: whatever precedes the first line break
      // belongs to a line that starts before `start`, and a line that starts
      // exactly at `start` is kept.
      const from = Math.max(0, start - 1);
      const buffer = Buffer.alloc(size - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      const lines = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/);
      if (from > 0) lines.shift();
      const kept = lines.filter(Boolean);
      if (kept.length >= limit || start === 0 || span >= maxReadBytes) return kept.slice(-limit);
      span = Math.min(span * 4, maxReadBytes);
    }
  } catch {
    return [];
  } finally {
    await handle.close();
  }
}
