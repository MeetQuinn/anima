import { open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';

import { kbFileExtension } from '../../shared/kb-file-types.js';
import { PATH_SAFE_ID } from '../../shared/path-ids.js';
import type { KbView } from '../../shared/kb.js';

// Error carrying an HTTP status; the API layer translates `statusCode` to the
// response code.
export class KbError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface KbDirectoryBrowse {
  path: string; // absolute server-side path
  entries: KbDirectoryEntry[];
}

export interface KbDirectoryEntry {
  name: string;
  path: string; // absolute server-side path
}

export interface ResolvedKbRoot {
  id: string;
  label: string;
  path: string; // absolute, validated directory
  teamId: string; // owning team (resolved; legacy KBs read as the default team)
}

// Text content larger than this is not inlined in the file API; the client
// falls back to the raw route. Keeps a giant tracked file from bloating a JSON
// response.
export const INLINE_TEXT_CAP = 2 * 1024 * 1024;

// How much of a file with an unrecognised extension is checked before we decide
// it is binary. Plain-text files often carry extensions no list anticipates
// (`.rules`, `.service`, a Surge `.conf` before it was listed), and calling them
// "Binary file" hides content anyone could read.
const TEXT_SNIFF_BYTES = 8 * 1024;

/**
 * Text check for bytes of unknown kind: no NUL byte and valid UTF-8. `partial`
 * marks a prefix sample, whose last character may be cut mid-sequence.
 */
export function looksLikeUtf8Text(bytes: Uint8Array, options: { partial?: boolean } = {}): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: options.partial === true });
    return true;
  } catch {
    return false;
  }
}

/**
 * For a file `kbFileKind` called binary only because of its extension: when the
 * bytes are text, the inline payload a text kind carries (content, or
 * `truncated` past the cap); otherwise undefined and the file stays binary.
 * Only the sample is read unless it already looks like text.
 */
export async function sniffUnknownText(
  absPath: string,
  size: number,
): Promise<{ content: string } | { truncated: true } | undefined> {
  const handle = await open(absPath, 'r');
  let sample: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(size, TEXT_SNIFF_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    sample = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (!looksLikeUtf8Text(sample, { partial: size > sample.length })) return undefined;
  if (size > INLINE_TEXT_CAP) return { truncated: true };
  const bytes = size > sample.length ? await readFile(absPath) : sample;
  return looksLikeUtf8Text(bytes) ? { content: bytes.toString('utf8') } : undefined;
}

// Short cache so an HTML report pulling many relative assets doesn't rescan the
// KB per asset. Visibility rarely changes within a page load; staleness
// self-heals on the next tick.
export const CACHE_TTL_MS = 5_000;
export const KB_ID = PATH_SAFE_ID;

export function normalizeRelPath(raw: string): string {
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) {
    throw new KbError(400, 'bad_path');
  }
  const normalized = posix.normalize(raw).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new KbError(400, 'bad_path');
  }
  if (normalized.startsWith('../') || normalized.includes('/../')) {
    throw new KbError(400, 'bad_path');
  }
  return normalized;
}

export function kbView(kb: ResolvedKbRoot): KbView {
  return { id: kb.id, label: kb.label, teamId: kb.teamId };
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function contentTypeFor(relPath: string): string {
  return RAW_CONTENT_TYPES[kbFileExtension(relPath)] ?? 'application/octet-stream';
}

const RAW_CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  woff2: 'font/woff2',
  woff: 'font/woff',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};
