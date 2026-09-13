import { replaceEqualDeep, type InfiniteData } from '@tanstack/react-query';
import type { AgentActivityFeedPage } from '@shared/activity';
import type { AgentMessageHistoryPage } from '@shared/messages';

// Live-tail merge for the Activity tab's two infinite feeds.
//
// An infinite query refetch re-fetches EVERY loaded page in sequence (TanStack
// `infiniteQueryBehavior`): with the coverage auto-fetch holding 40+ pages of
// activity, a 3s poll meant 40+ requests and a full re-render per response
// (the measured "text jitters / touch drag lags" on a working agent). The poll
// now fetches only the newest page and this module folds it into the cached
// pages:
//   - items whose id is unknown are appended to page 0 (the newest page);
//   - items already cached are re-checked with structural sharing, so a record
//     the server rewrote is replaced while identical records keep identity;
//   - when nothing changed the SAME `InfiniteData` reference comes back, so the
//     observers do not notify and React does not re-render.
// `gap` flags the one case a single page cannot cover: the newest page shares
// no item with a non-empty cache, i.e. more than a page of items arrived since
// the last poll. The caller falls back to a full refetch for that poll.

export interface LiveMergeResult<TData> {
  data: TData;
  changed: boolean;
  added: number;
  replaced: number;
  gap: boolean;
}

type Side = 'end' | 'start';

function mergeLatestItems<T>(
  pages: readonly (readonly T[])[],
  latest: readonly T[],
  idOf: (item: T) => string,
  side: Side,
): { pages: T[][] | null; added: number; replaced: number; gap: boolean } {
  const where = new Map<string, [number, number]>();
  let cached = 0;
  pages.forEach((page, pi) =>
    page.forEach((item, ii) => {
      where.set(idOf(item), [pi, ii]);
      cached += 1;
    }),
  );

  const fresh: T[] = [];
  const replacements = new Map<number, Map<number, T>>();
  let overlap = 0;
  for (const item of latest) {
    const loc = where.get(idOf(item));
    if (!loc) {
      fresh.push(item);
      continue;
    }
    overlap += 1;
    const current = pages[loc[0]]![loc[1]]!;
    const shared = replaceEqualDeep(current, item);
    if (shared !== current) {
      let byIndex = replacements.get(loc[0]);
      if (!byIndex) {
        byIndex = new Map();
        replacements.set(loc[0], byIndex);
      }
      byIndex.set(loc[1], shared);
    }
  }

  const gap = cached > 0 && latest.length > 0 && overlap === 0;
  let replaced = 0;
  for (const byIndex of replacements.values()) replaced += byIndex.size;
  if (fresh.length === 0 && replaced === 0) return { pages: null, added: 0, replaced: 0, gap };

  const next = pages.map((page, pi) => {
    const byIndex = replacements.get(pi);
    let out: T[] = byIndex ? page.map((item, ii) => byIndex.get(ii) ?? item) : (page as T[]);
    if (pi === 0 && fresh.length > 0) out = side === 'end' ? [...out, ...fresh] : [...fresh, ...out];
    return out;
  });
  return { pages: next, added: fresh.length, replaced, gap };
}

type ActivityData = InfiniteData<AgentActivityFeedPage, string | undefined>;
type MessageData = InfiniteData<AgentMessageHistoryPage, string | undefined>;

function unchanged<TData>(data: TData, gap = false): LiveMergeResult<TData> {
  return { data, changed: false, added: 0, replaced: 0, gap };
}

/** Activity pages are oldest→newest within a page; fresh events go to the END of page 0. */
export function mergeLatestActivityPage(
  prev: ActivityData | undefined,
  latest: AgentActivityFeedPage,
): LiveMergeResult<ActivityData | undefined> {
  if (!prev || prev.pages.length === 0) return unchanged(prev);
  const inputs = prev.pages.map((page) => page.events ?? []);
  const merged = mergeLatestItems(inputs, latest.events ?? [], (event) => event.activityId, 'end');
  if (!merged.pages) return unchanged(prev, merged.gap);
  const pages = prev.pages.map((page, pi) =>
    merged.pages![pi] === inputs[pi] ? page : { ...page, events: merged.pages![pi]! },
  );
  return {
    data: { pages, pageParams: prev.pageParams },
    changed: true,
    added: merged.added,
    replaced: merged.replaced,
    gap: merged.gap,
  };
}

/** Message pages are newest→oldest within a page; fresh entries go to the START of page 0. */
export function mergeLatestMessagePage(
  prev: MessageData | undefined,
  latest: AgentMessageHistoryPage,
): LiveMergeResult<MessageData | undefined> {
  if (!prev || prev.pages.length === 0) return unchanged(prev);
  const inputs = prev.pages.map((page) => page.entries ?? []);
  const merged = mergeLatestItems(inputs, latest.entries ?? [], (entry) => entry.messageId, 'start');
  if (!merged.pages) return unchanged(prev, merged.gap);
  const pages = prev.pages.map((page, pi) =>
    merged.pages![pi] === inputs[pi] ? page : { ...page, entries: merged.pages![pi]! },
  );
  return {
    data: { pages, pageParams: prev.pageParams },
    changed: true,
    added: merged.added,
    replaced: merged.replaced,
    gap: merged.gap,
  };
}
