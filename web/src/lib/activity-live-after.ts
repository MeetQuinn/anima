// Live tail by anchor: read forward from the position the cache is known to
// end at (`headCursor` in cached page 0) instead of re-reading the newest page.
//
// One poll reads `after=<anchor>` and, while the server says `hasMore`,
// continues from the LAST ROW IT ACTUALLY RETURNED, at most
// AFTER_REQUEST_BUDGET requests in all. The caller commits the rows and the new
// anchor together only when the whole read completed. Every other outcome
// commits nothing and leaves the anchor alone, so the next poll re-reads from
// the same place (ids make the re-read idempotent):
//   - over budget: more arrived than a bounded read covers; the caller falls
//     back to re-fetching the feed, as the newest-page probe does on a gap;
//   - anchor rejected (410 cursor_expired, 400 cursor_invalid): the anchor row
//     is gone or no longer unique; the same fallback re-seeds it;
//   - not supported: the server answered without `readAfter`, i.e. a runtime
//     that ignores `after` sent its newest page. The caller treats it exactly
//     as the newest-page probe would, gap check included;
//   - any other failure (503 history_unstable mid-read, network) throws.

export const AFTER_REQUEST_BUDGET = 5;

export interface AfterRows<TRow> {
  rows: readonly TRow[];
  afterCursor: string | null;
  hasMore: boolean;
}

export type AfterReadResult<TRow, TLatest> =
  | { kind: 'complete'; rows: TRow[]; cursor: string; requests: number }
  | { kind: 'over-budget'; requests: number }
  | { kind: 'anchor-rejected'; requests: number }
  | { kind: 'not-supported'; latest: TLatest; requests: number };

/** apiRequest keeps only the body's `error`; HistoryReadError puts its code first. */
export function isAnchorRejected(error: unknown): boolean {
  return error instanceof Error && /^cursor_(expired|invalid):/.test(error.message);
}

export async function readAfterAnchor<TRow, TLatest>(
  anchor: string,
  fetchAfter: (cursor: string) => Promise<{ after: AfterRows<TRow> } | { latest: TLatest }>,
): Promise<AfterReadResult<TRow, TLatest>> {
  const rows: TRow[] = [];
  let cursor = anchor;
  for (let request = 1; request <= AFTER_REQUEST_BUDGET; request += 1) {
    let page: { after: AfterRows<TRow> } | { latest: TLatest };
    try {
      page = await fetchAfter(cursor);
    } catch (error) {
      if (isAnchorRejected(error)) return { kind: 'anchor-rejected', requests: request };
      throw error;
    }
    if (!('after' in page)) return { kind: 'not-supported', latest: page.latest, requests: request };
    rows.push(...page.after.rows);
    if (page.after.afterCursor) cursor = page.after.afterCursor;
    if (!page.after.hasMore) return { kind: 'complete', rows, cursor, requests: request };
  }
  return { kind: 'over-budget', requests: AFTER_REQUEST_BUDGET };
}
