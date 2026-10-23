import { open } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import { HttpError } from './http.js';

export async function serveRawFile(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  headers: Record<string, string>,
): Promise<void> {
  // Stat and stream the same open file, including when a writer replaces its path.
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new HttpError(400, 'not_a_file');
    // Range is defined only for GET. We emit no validators, so If-Range cannot
    // match and must fall back to a complete representation (RFC 9110 §14.2).
    const range = request.method === 'GET' && request.headers['if-range'] === undefined
      ? singleByteRange(request.headers.range, info.size)
      : undefined;
    const responseHeaders = { ...headers, 'accept-ranges': 'bytes' };
    if (range === 'unsatisfiable') {
      response.writeHead(416, { ...responseHeaders, 'content-range': `bytes */${info.size}`, 'content-length': '0' });
      response.end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    const length = range ? end - start + 1 : info.size;
    const contentHeaders: Record<string, string> = { ...responseHeaders, 'content-length': String(length) };
    if (range) contentHeaders['content-range'] = `bytes ${start}-${end}/${info.size}`;
    response.writeHead(range ? 206 : 200, contentHeaders);
    if (request.method === 'HEAD' || length === 0) {
      response.end();
      return;
    }
    // Pipeline propagates client disconnects back to the file stream and applies
    // socket backpressure. The handle is closed here on every completion path.
    await pipeline(file.createReadStream({ start, end, autoClose: false }), response);
  } catch (error) {
    if (!response.headersSent) throw error;
    response.destroy();
  } finally {
    await file.close();
  }
}

function singleByteRange(value: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = value?.trim().match(/^bytes=(\d*)-(\d*)$/i);
  // Unsupported units, malformed ranges and multipart requests use a full 200.
  if (!match || (!match[1] && !match[2])) return undefined;
  const total = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]!);
    if (suffix === 0n || total === 0n) return 'unsatisfiable';
    return { start: Number(suffix >= total ? 0n : total - suffix), end: size - 1 };
  }
  const first = BigInt(match[1]);
  const last = match[2] ? BigInt(match[2]) : undefined;
  if (last !== undefined && last < first) return undefined;
  if (first >= total) return 'unsatisfiable';
  return { start: Number(first), end: Number(last === undefined || last >= total ? total - 1n : last) };
}
