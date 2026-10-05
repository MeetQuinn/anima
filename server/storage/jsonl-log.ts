import { appendFile, open, readFile, readdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { cacheDelete, cacheHit, cachePeek, cacheSet, isMissingFile, statOrNull } from './json-file.js';
import { withFileLock } from './lock.js';
import { currentWriteRoot, ensureParentDirectory } from './write-root.js';
import { HistoryReadError, type LogPosition } from './history-cursor.js';

interface LogSegment { path: string; dev: string; ino: string }
export interface PositionedRecord<T> { record: T; position: LogPosition }
class SegmentChanged extends Error {}

export const DEFAULT_JSONL_ROTATE_BYTES = 10 * 1024 * 1024;

/**
 * How page segment reads were served, process-wide. `incremental` parsed only
 * the bytes appended after a cached read; `full` parsed the whole segment.
 */
export const jsonlPageReadStats = { hit: 0, full: 0, incremental: 0 };

interface PageSegmentEntry<T> {
  records: T[];
  /** The exact bytes `records` were parsed from; kept for the live file only. */
  bytes?: Buffer;
}

/** Live path -> page cache key of the file now at that path. */
const livePageKeys = new Map<string, string>();

function parseLines<T>(bytes: Buffer): T[] {
  return bytes.toString('utf8').split(/\r?\n/)
    .filter((s) => s.trim() !== '').map((s) => JSON.parse(s) as T);
}

/**
 * True when `next` holds every byte of `prior` unchanged and then more, and
 * `prior` ends at a line break. Then parsing `next` equals parsing `prior`
 * followed by parsing the rest. File metadata cannot show this: an in-place
 * edit plus an append keeps the inode and grows the size just like an append.
 */
function extendsPrior(prior: Buffer, next: Buffer): boolean {
  return prior.length > 0 && next.length > prior.length
    && prior[prior.length - 1] === 0x0a
    && next.compare(prior, 0, prior.length, 0, prior.length) === 0;
}

export interface JsonlRotationOptions {
  archiveDir?: string;
  maxBytes?: number;
  /**
   * Cap on how many rotated archive segments to retain. After a rotation, the
   * oldest archives beyond this count are deleted, bounding total disk use at
   * roughly `(maxArchives + 1) * maxBytes`. Omitted/undefined ⇒ keep all
   * archives (the historical behavior); `0` ⇒ keep none.
   */
  maxArchives?: number;
}

export class JsonlAppendLog<T> {
  /** Captured once; never re-derived at write time. See storage/write-root.ts. */
  private readonly writeRoot: string;

  constructor(
    readonly path: string,
    private readonly rotation: JsonlRotationOptions = {},
    writeRoot: string = currentWriteRoot(),
  ) {
    this.writeRoot = writeRoot;
  }

  async append(record: T): Promise<void> {
    await withFileLock(this.path, this.writeRoot, async () => {
      await this.rotateIfNeeded();
      await ensureParentDirectory(this.path, this.writeRoot);
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
      cacheDelete(this.path);
    });
  }

  async appendIf(record: T, shouldAppend: (records: T[]) => boolean): Promise<{ appended: boolean }> {
    return withFileLock(this.path, this.writeRoot, async () => {
      const records = await this.readAllFromDisk();
      if (!shouldAppend(records)) {
        await this.refreshCache(records);
        return { appended: false };
      }
      await this.rotateIfNeeded();
      await ensureParentDirectory(this.path, this.writeRoot);
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
      await this.refreshCache([...records, record]);
      return { appended: true };
    });
  }

  async appendIfRecent(
    record: T,
    shouldAppend: (recentRecords: T[]) => boolean,
    recentLimit: number,
  ): Promise<{ appended: boolean }> {
    return withFileLock(this.path, this.writeRoot, async () => {
      const recentRecords = await this.readTailFromDisk(recentLimit);
      if (!shouldAppend(recentRecords)) return { appended: false };
      await this.rotateIfNeeded();
      await ensureParentDirectory(this.path, this.writeRoot);
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
      cacheDelete(this.path);
      return { appended: true };
    });
  }

  async appendManyByKey(records: T[], keyOf: (record: T) => string): Promise<{ appended: number }> {
    if (records.length === 0) return { appended: 0 };
    return withFileLock(this.path, this.writeRoot, async () => {
      const current = await this.readAllFromDisk();
      const seen = new Set(current.map(keyOf));
      const missing: T[] = [];
      for (const record of records) {
        const key = keyOf(record);
        if (seen.has(key)) continue;
        seen.add(key);
        missing.push(record);
      }
      if (missing.length === 0) {
        await this.refreshCache(current);
        return { appended: 0 };
      }
      await this.rotateIfNeeded();
      await ensureParentDirectory(this.path, this.writeRoot);
      await appendFile(this.path, `${missing.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
      await this.refreshCache([...current, ...missing]);
      return { appended: missing.length };
    });
  }

  /**
   * Read the last `n` records from the log by seeking from the end of the
   * file. Avoids loading the full file when the log is large (e.g. 276MB).
   * Falls back to readAll when the estimated read window covers the whole file.
   */
  async readTail(n: number): Promise<T[]> {
    return this.readTailFromDisk(n);
  }

  async readNewestMatching(n: number, matches: (record: T) => boolean): Promise<T[]> {
    if (n <= 0) return [];
    const segments = this.rotationEnabled()
      ? await this.segmentPaths()
      : (await statOrNull(this.path)) ? [this.path] : [];
    const out: T[] = [];
    for (const path of segments.reverse()) {
      const records = await this.readAllFromPath(path);
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (record !== undefined && matches(record)) out.push(record);
        if (out.length >= n) return out;
      }
    }
    return out;
  }

  /**
   * Append-order pagination. Positions remain valid when live is renamed.
   * `older` (default) walks newest to oldest, from the end or from just
   * before `anchor`. `newer` walks oldest to newest from just after `anchor`
   * and needs one. Both skip the anchor row itself.
   */
  async readPage(input: {
    limit: number;
    matches: (record: T) => boolean;
    idOf: (record: T) => string;
    anchor?: { p: LogPosition; id: string };
    direction?: 'older' | 'newer';
  }): Promise<{ rows: PositionedRecord<T>[]; hasMore: boolean }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const segments = await this.pageSegments();
      let result: { rows: PositionedRecord<T>[]; hasMore: boolean } | undefined;
      let failure: unknown;
      try {
        result = await this.scanPage(segments, input);
      } catch (error) {
        failure = error;
      }
      const after = await this.pageSegments();
      // Check every scan, even a successful short first page or missing anchor.
      if (failure instanceof SegmentChanged || JSON.stringify(segments) !== JSON.stringify(after)) continue;
      if (failure) throw failure;
      if (result) return result;
    }
    throw new HistoryReadError('history_unstable', 503, 'History rotated during the read; retry this page.');
  }

  private async scanPage(segments: LogSegment[], input: {
    limit: number;
    matches: (record: T) => boolean;
    idOf: (record: T) => string;
    anchor?: { p: LogPosition; id: string };
    direction?: 'older' | 'newer';
  }): Promise<{ rows: PositionedRecord<T>[]; hasMore: boolean }> {
    const loaded = new Map<number, T[]>();
    const read = async (i: number): Promise<T[]> => {
      let records = loaded.get(i);
      if (!records) {
        records = await this.readPageSegment(segments[i]!);
        loaded.set(i, records);
      }
      return records;
    };
    let segmentIndex = segments.length - 1;
    let line: number | undefined;
    if (input.anchor) {
      const { p, id } = input.anchor;
      segmentIndex = segments.findIndex((s) => s.dev === p.dev && s.ino === p.ino);
      const candidate = segmentIndex < 0 ? undefined : (await read(segmentIndex))[p.line];
      if (candidate !== undefined && input.idOf(candidate) === id) {
        line = p.line;
      } else {
        // Restore/copy/manual rewrite: only a unique logical id is safe.
        const occurrences: { segment: number; line: number }[] = [];
        for (let i = 0; i < segments.length; i += 1) {
          (await read(i)).forEach((record, j) => {
            if (input.idOf(record) === id) occurrences.push({ segment: i, line: j });
          });
        }
        if (occurrences.length !== 1) {
          throw new HistoryReadError('cursor_expired', 410,
            occurrences.length === 0 ? 'anchor_missing; reload the first page.' : 'anchor_ambiguous; reload the first page.');
        }
        segmentIndex = occurrences[0]!.segment;
        line = occurrences[0]!.line;
      }
    }
    const rows: PositionedRecord<T>[] = [];
    if (input.direction === 'newer') {
      if (line === undefined) throw new Error('readPage newer needs an anchor');
      for (let i = segmentIndex; i < segments.length; i += 1) {
        const records = await read(i);
        for (let j = i === segmentIndex ? line + 1 : 0; j < records.length; j += 1) {
          const record = records[j]!;
          if (!input.matches(record)) continue;
          if (rows.length === input.limit) return { rows, hasMore: true };
          const segment = segments[i]!;
          rows.push({ record, position: { dev: segment.dev, ino: segment.ino, line: j } });
        }
      }
      return { rows, hasMore: false };
    }
    if (line !== undefined) line -= 1;
    for (let i = segmentIndex; i >= 0; i -= 1) {
      const records = await read(i);
      for (let j = line ?? records.length - 1; j >= 0; j -= 1) {
        const record = records[j]!;
        if (!input.matches(record)) continue;
        if (rows.length === input.limit) return { rows, hasMore: true };
        const segment = segments[i]!;
        rows.push({ record, position: { dev: segment.dev, ino: segment.ino, line: j } });
      }
      line = undefined;
    }
    return { rows, hasMore: false };
  }

  private async pageSegments(): Promise<LogSegment[]> {
    const paths = this.rotationEnabled() ? await this.segmentPaths() : [this.path];
    const segments = await Promise.all(paths.map(async (path) => {
      try {
        const info = await stat(path, { bigint: true });
        return { path, dev: String(info.dev), ino: String(info.ino) };
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        throw error;
      }
    }));
    return segments.filter((s): s is LogSegment => s !== undefined);
  }

  private async readPageSegment(segment: LogSegment): Promise<T[]> {
    let fd: FileHandle | undefined;
    try {
      fd = await open(segment.path, 'r');
      const info = await fd.stat({ bigint: true });
      if (String(info.dev) !== segment.dev || String(info.ino) !== segment.ino) throw new SegmentChanged();
      const cacheKey = `${segment.path}:${segment.dev}:${segment.ino}`;
      const stamp = { size: Number(info.size), mtimeMs: Number(info.mtimeMs) };
      const hit = cacheHit<PageSegmentEntry<T>>(cacheKey, stamp);
      if (hit) {
        jsonlPageReadStats.hit += 1;
        return hit.records;
      }
      // Bind the rows and their line positions to this handle, not a path
      // reopened after rename. A live append cannot extend this read window.
      const bytes = Buffer.alloc(stamp.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new SegmentChanged();
        offset += bytesRead;
      }
      // The live file changes on every append. Parse only what follows the
      // bytes already parsed, after proving each of those bytes is unchanged.
      const prior = cachePeek<PageSegmentEntry<T>>(cacheKey);
      let records: T[];
      if (prior?.bytes && extendsPrior(prior.bytes, bytes)) {
        records = prior.records.concat(parseLines<T>(bytes.subarray(prior.bytes.length)));
        jsonlPageReadStats.incremental += 1;
      } else {
        records = parseLines<T>(bytes);
        jsonlPageReadStats.full += 1;
      }
      if (segment.path !== this.path) {
        cacheSet(cacheKey, { records }, stamp);
        return records;
      }
      cacheSet(cacheKey, { records, bytes }, stamp);
      // A rotated or replaced live file is read under its new path or not at
      // all; drop its old entry (and bytes) instead of waiting for LRU eviction.
      const previousKey = livePageKeys.get(segment.path);
      if (previousKey !== undefined && previousKey !== cacheKey) cacheDelete(previousKey);
      livePageKeys.set(segment.path, cacheKey);
      return records;
    } catch (error) {
      if (isMissingFile(error)) throw new SegmentChanged();
      throw error;
    } finally {
      await fd?.close();
    }
  }

  async readNewestUntil(shouldStop: (record: T) => boolean): Promise<T[]> {
    const segments = this.rotationEnabled()
      ? await this.segmentPaths()
      : (await statOrNull(this.path)) ? [this.path] : [];
    const out: T[] = [];
    for (const path of segments.reverse()) {
      const records = await this.readAllFromPath(path);
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (record === undefined) continue;
        if (shouldStop(record)) return out;
        out.push(record);
      }
    }
    return out;
  }

  async readAll(): Promise<T[]> {
    if (this.rotationEnabled()) return this.readAllFromDisk();
    const fileStat = await statOrNull(this.path);
    if (fileStat) {
      const hit = cacheHit<T[]>(this.path, fileStat);
      if (hit !== undefined) {
        return hit.slice();
      }
    }
    const records = await this.readAllFromDisk();
    if (fileStat) {
      cacheSet(this.path, records, fileStat);
    }
    return records;
  }

  private async readRotatingTail(n: number): Promise<T[]> {
    if (n <= 0) return [];
    const segments = await this.segmentPaths();
    const out: T[] = [];
    for (const path of segments.reverse()) {
      const chunk = await this.readTailFromPath(path, n - out.length);
      out.unshift(...chunk);
      if (out.length >= n) return out.slice(-n);
    }
    return out;
  }

  private async readTailFromDisk(n: number): Promise<T[]> {
    if (this.rotationEnabled()) {
      return this.readRotatingTail(n);
    }
    return this.readTailFromPath(this.path, n);
  }

  private async readTailFromPath(path: string, n: number): Promise<T[]> {
    const fileStat = await statOrNull(path);
    if (!fileStat || fileStat.size === 0) return [];

    // Check cache first — if file is unchanged we can slice in memory.
    const hit = cacheHit<T[]>(path, fileStat);
    if (hit !== undefined) return hit.slice(-n);

    // Estimate bytes needed: 300 bytes/line × n × 2 safety factor.
    const AVG_LINE_BYTES = 300;
    const estimatedBytes = n * AVG_LINE_BYTES * 2;

    // Small file — just read all, same cost as seeking.
    if (estimatedBytes >= fileStat.size) {
      const all = await this.readAllFromPath(path);
      return all.slice(-n);
    }

    // Large file — seek from the end, doubling the window until we have n lines.
    let fd: FileHandle | undefined;
    try {
      fd = await open(path, 'r');
      let readSize = estimatedBytes;
      for (let attempt = 0; attempt < 5; attempt++) {
        const start = Math.max(0, fileStat.size - readSize);
        const bufLen = fileStat.size - start;
        const buf = Buffer.allocUnsafe(bufLen);
        await fd.read(buf, 0, bufLen, start);
        const text = buf.toString('utf8');
        // First line may be a partial record if we started mid-file — drop it.
        const rawLines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
        const lines = start > 0 ? rawLines.slice(1) : rawLines;
        if (lines.length >= n || start === 0) {
          return lines.slice(-n).map((l) => JSON.parse(l) as T);
        }
        // Not enough lines — double the read window and retry.
        readSize = Math.min(fileStat.size, readSize * 2);
      }
      // Should not reach here — fallback to readAll.
      return (await this.readAllFromPath(path)).slice(-n);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    } finally {
      await fd?.close();
    }
  }

  private async readAllFromDisk(): Promise<T[]> {
    if (this.rotationEnabled()) {
      const chunks = await Promise.all((await this.segmentPaths()).map((path) => this.readAllFromPath(path)));
      return chunks.flat();
    }
    return this.readAllFromPath(this.path);
  }

  private async readAllFromPath(path: string): Promise<T[]> {
    const fileStat = await statOrNull(path);
    if (!fileStat || fileStat.size === 0) return [];
    const hit = cacheHit<T[]>(path, fileStat);
    if (hit !== undefined) return hit.slice();
    try {
      const records = (await readFile(path, 'utf8'))
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as T);
      cacheSet(path, records, fileStat);
      return records.slice();
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  private async refreshCache(records: T[]): Promise<void> {
    if (this.rotationEnabled()) {
      cacheDelete(this.path);
      return;
    }
    const fileStat = await statOrNull(this.path);
    if (fileStat) {
      cacheSet(this.path, records, fileStat);
    } else {
      cacheDelete(this.path);
    }
  }

  private rotationEnabled(): boolean {
    return Number.isFinite(this.rotation.maxBytes) && Number(this.rotation.maxBytes) > 0;
  }

  private async rotateIfNeeded(): Promise<void> {
    const maxBytes = this.rotation.maxBytes;
    if (!Number.isFinite(maxBytes) || Number(maxBytes) <= 0) return;
    const fileStat = await statOrNull(this.path);
    if (!fileStat || fileStat.size < Number(maxBytes)) return;
    const archivePath = await this.nextArchivePath();
    await ensureParentDirectory(archivePath, this.writeRoot);
    await rename(this.path, archivePath);
    cacheDelete(this.path);
    cacheDelete(archivePath);
    await this.pruneArchives();
  }

  // Enforce the optional retention cap: keep only the newest `maxArchives`
  // segments, deleting the oldest. ownArchivePaths() returns ONLY this log's own
  // segments (scoped by the archive-name pattern, so a shared archive dir never
  // prunes another log's files), sorted ascending by the timestamp-prefixed
  // name — oldest at the front. Best-effort: a file already gone is fine; other
  // errors propagate like rotation itself.
  private async pruneArchives(): Promise<void> {
    const maxArchives = this.rotation.maxArchives;
    if (!Number.isFinite(maxArchives) || Number(maxArchives) < 0) return;
    const archives = await this.ownArchivePaths();
    const excess = archives.length - Number(maxArchives);
    if (excess <= 0) return;
    for (const path of archives.slice(0, excess)) {
      try {
        await unlink(path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      cacheDelete(path);
    }
  }

  // Archive segments produced by THIS log only. nextArchivePath() names them
  // `<13+ digit stamp>-<base>-<3 digit seq>.jsonl`, so we match that exact shape
  // for this log's base name — never another log sharing the same archive dir.
  private async ownArchivePaths(): Promise<string[]> {
    const base = basename(this.path).replace(/\.jsonl$/i, '');
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const own = new RegExp(`^\\d{13,}-${escaped}-\\d{3}\\.jsonl$`);
    return (await this.archivePaths()).filter((path) => own.test(basename(path)));
  }

  private async segmentPaths(): Promise<string[]> {
    const archives = await this.archivePaths();
    return (await statOrNull(this.path)) ? [...archives, this.path] : archives;
  }

  private async archivePaths(): Promise<string[]> {
    try {
      const entries = await readdir(this.archiveDir(), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => join(this.archiveDir(), entry.name))
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  private async nextArchivePath(): Promise<string> {
    const base = basename(this.path).replace(/\.jsonl$/i, '');
    const stamp = `${String(Date.now()).padStart(13, '0')}-${base}`;
    for (let i = 0; i < 1000; i += 1) {
      const suffix = `-${String(i).padStart(3, '0')}`;
      const candidate = join(this.archiveDir(), `${stamp}${suffix}.jsonl`);
      if (!(await statOrNull(candidate))) return candidate;
    }
    throw new Error(`Could not allocate archive path for ${this.path}`);
  }

  private archiveDir(): string {
    return this.rotation.archiveDir ?? `${this.path}.archive`;
  }
}
