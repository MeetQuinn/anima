import { open } from 'node:fs/promises';

const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Calls `onLine` with each line of a file from byte `offset`, plus the byte
 * offset where that line starts. The file is read in chunks, so even a file of
 * several gigabytes never becomes one string.
 *
 * Each line is a Buffer that is valid only during the call, so a caller can
 * skip a line without decoding it. Return true from `onLine` to stop early.
 * The last line is passed even without a trailing newline. If the file is now
 * shorter than `offset`, the read starts from 0.
 */
export async function forEachFileLine(
  path: string,
  offset: number,
  onLine: (line: Buffer, offset: number) => boolean | void,
): Promise<void> {
  const handle = await open(path, 'r');
  try {
    let position = offset <= (await handle.stat()).size ? offset : 0;
    let lineOffset = position;
    let pending: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      let start = 0;
      // A 0x0a byte never occurs inside a multi-byte UTF-8 sequence.
      for (let end = data.indexOf(0x0a); end !== -1; end = data.indexOf(0x0a, start)) {
        const segment = data.subarray(start, end);
        const line = pending.length === 0 ? segment : Buffer.concat([...pending, segment]);
        pending = [];
        if (onLine(line, lineOffset) === true) return;
        start = end + 1;
        lineOffset = position + start;
      }
      if (start < bytesRead) pending.push(Buffer.from(data.subarray(start)));
      position += bytesRead;
    }
    if (pending.length > 0) onLine(Buffer.concat(pending), lineOffset);
  } finally {
    await handle.close();
  }
}
