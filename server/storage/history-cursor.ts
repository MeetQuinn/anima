import { z } from 'zod';

export interface LogPosition {
  dev: string;
  ino: string;
  line: number;
}

const Filters = z.object({
  beforeTime: z.string().datetime().optional(),
  channel: z.string().min(1).optional(),
  direction: z.enum(['in', 'out']).optional(),
  keywords: z.array(z.string().min(1)).optional(),
  since: z.string().datetime().optional(),
  threadTs: z.string().min(1).optional(),
}).strict();
export type HistoryFilters = z.infer<typeof Filters>;

const Cursor = z.object({
  v: z.literal(1),
  k: z.enum(['activity', 'messages']),
  a: z.string().min(1),
  f: Filters,
  p: z.object({
    dev: z.string().regex(/^\d+$/),
    ino: z.string().regex(/^\d+$/),
    line: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  id: z.string().min(1),
}).strict();
export type HistoryCursor = z.infer<typeof Cursor>;

export class HistoryReadError extends Error {
  constructor(
    readonly code: 'cursor_invalid' | 'cursor_expired' | 'history_unstable',
    readonly statusCode: number,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export function encodeHistoryCursor(cursor: Omit<HistoryCursor, 'v'>): string {
  return `c1.${Buffer.from(JSON.stringify({ v: 1, ...cursor })).toString('base64url')}`;
}

export function decodeHistoryCursor(value: string): HistoryCursor {
  try {
    if (!/^c1\.[A-Za-z0-9_-]+$/.test(value) || value.length > 16_384) throw new Error();
    return Cursor.parse(JSON.parse(Buffer.from(value.slice(3), 'base64url').toString('utf8')));
  } catch {
    throw new HistoryReadError('cursor_invalid', 400, 'Invalid history cursor; reload the first page.');
  }
}

export function normalizeHistoryTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new HistoryReadError('cursor_invalid', 400, 'History time filters must be ISO timestamps.');
  }
  return date.toISOString();
}

/** Omitted filters inherit the cursor's scope; explicit changes are rejected. */
export function resolveHistoryQuery(input: {
  agentId: string;
  kind: HistoryCursor['k'];
  before?: string;
  cursor?: string;
  filters?: HistoryFilters;
}): { anchor?: HistoryCursor; filters: HistoryFilters } {
  const alias = input.before?.startsWith('c1.') ? input.before : undefined;
  if (alias && input.cursor && alias !== input.cursor) {
    throw new HistoryReadError('cursor_invalid', 400, 'Conflicting history cursors.');
  }
  const value = input.cursor ?? alias;
  const explicit: HistoryFilters = { ...input.filters };
  if (input.before && !alias) explicit.beforeTime = normalizeHistoryTime(input.before);
  if (explicit.since) explicit.since = normalizeHistoryTime(explicit.since);
  if (explicit.channel !== undefined) explicit.channel = explicit.channel.trim();
  if (explicit.threadTs !== undefined) explicit.threadTs = explicit.threadTs.trim();
  if (explicit.keywords) explicit.keywords = [...new Set(explicit.keywords)].sort();
  // Spreads from CLI inputs may contain undefined, which means omitted.
  const filters = Object.fromEntries(Object.entries(explicit).filter(([, v]) => v !== undefined)) as HistoryFilters;
  if (!value) return { filters: Filters.parse(filters) };
  const anchor = decodeHistoryCursor(value);
  if (anchor.a !== input.agentId || anchor.k !== input.kind) {
    throw new HistoryReadError('cursor_invalid', 400, 'Cursor belongs to another agent or feed.');
  }
  for (const key of Object.keys(filters) as (keyof HistoryFilters)[]) {
    if (JSON.stringify(filters[key]) !== JSON.stringify(anchor.f[key])) {
      throw new HistoryReadError('cursor_invalid', 400, `Cursor ${key} filter differs; reload the first page.`);
    }
  }
  if (input.kind === 'activity' && Object.keys(anchor.f).some((key) => key !== 'beforeTime')) {
    throw new HistoryReadError('cursor_invalid', 400, 'Invalid activity cursor filters.');
  }
  return { anchor, filters: anchor.f };
}
