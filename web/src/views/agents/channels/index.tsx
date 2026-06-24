import { useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AtSign, BellOff, ChevronLeft, Hash, Loader2 } from 'lucide-react';
import { fetchAgentChannels, fetchAgentMessages } from '@/api/agents';
import { buildMessageFeed, type ActivityFeedItem } from '@/lib/activity-feed';
import { clockHM, dateKey, formatRelativeShort } from '@/lib/format';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useNow } from '@/hooks/useNow';
import { MessageInRow, MessageOutRow, FileOutRow } from '../activity/MessageRows';
import { ReactOutRow, DaySection } from '../activity/AuditRows';
import type { AgentChannelSummary, AgentMessageRecord } from '@shared/messages';

type Dir = 'all' | 'in' | 'out';

function channelLabel(channel: AgentChannelSummary): string {
  const fallback = channel.id;
  const name = channel.name ?? fallback;
  return channel.kind === 'dm' ? `@${name}` : `#${name}`;
}

function isMessageItem(item: ActivityFeedItem): boolean {
  return (
    item.kind === 'message-in' ||
    item.kind === 'message-out' ||
    item.kind === 'file-out' ||
    item.kind === 'reaction-out'
  );
}

// ---------------------------------------------------------------------------
// Master list row
// ---------------------------------------------------------------------------

function ChannelRow({
  channel,
  active,
  now,
  onSelect,
}: {
  channel: AgentChannelSummary;
  active: boolean;
  now: Date;
  onSelect: () => void;
}) {
  const Icon = channel.kind === 'dm' ? AtSign : Hash;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        'flex w-full items-center gap-2.5 border-l-2 px-4 py-2.5 text-left transition-colors',
        active
          ? 'border-accent bg-accent/5'
          : 'border-transparent hover:bg-surface-raised/40',
      ].join(' ')}
    >
      <Icon
        className={['h-3.5 w-3.5 shrink-0', active ? 'text-accent' : 'text-text-subtle'].join(' ')}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[13px] leading-tight text-text">
          {channel.name ?? channel.id}
        </span>
        {channel.lastActivityAt && (
          <span className="block font-sans text-[10px] leading-tight text-text-subtle">
            {formatRelativeShort(channel.lastActivityAt, now)}
          </span>
        )}
      </span>
      {channel.status === 'muted' && (
        <BellOff className="h-3 w-3 shrink-0 text-text-subtle" aria-label="Muted" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Direction filter pill (mirrors the Activity Conversation lens)
// ---------------------------------------------------------------------------

function DirPill({ dir, onChange }: { dir: Dir; onChange: (v: Dir) => void }) {
  const base = 'chrome px-2.5 py-1 text-[11px] tracking-wide rounded-sm transition-colors';
  const active = 'bg-accent/10 text-accent font-medium';
  const inactive = 'text-text-muted hover:text-text';
  return (
    <div className="flex items-center rounded-sm border border-border-soft p-0.5">
      {(['all', 'in', 'out'] as Dir[]).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={[base, dir === v ? active : inactive].join(' ')}
        >
          {v === 'all' ? 'All' : v === 'in' ? 'Inbox' : 'Outbox'}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail pane — one channel's conversation. Reuses the Activity message rows
// and feed builder; filters the global message feed to the selected channel
// (server has no per-channel route in v1; client-side filter per spec).
// ---------------------------------------------------------------------------

function ConversationPane({
  agentId,
  channel,
  dir,
  onDir,
  onBack,
}: {
  agentId: string;
  channel: AgentChannelSummary;
  dir: Dir;
  onDir: (v: Dir) => void;
  onBack: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageDirection = dir === 'all' ? undefined : dir;

  const messageQuery = useInfiniteQuery({
    queryKey: [...queryKeys.agentMessages(agentId, dir), 'channels'] as const,
    queryFn: ({ pageParam }) =>
      fetchAgentMessages(agentId, { before: pageParam, direction: messageDirection, limit: 200 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: refetchIntervals.agentActivities,
  });

  // Merge loaded pages, dedupe, then filter to this channel. The React Compiler
  // memoizes these derived values; manual useMemo here fights its analysis
  // (preserve-manual-memoization), so keep them plain.
  const pages = messageQuery.data?.pages;
  const entryMap = new Map<string, AgentMessageRecord>();
  for (const page of pages ?? []) {
    for (const entry of page.entries ?? []) entryMap.set(entry.messageId, entry);
  }
  const entries = Array.from(entryMap.values()).filter((e) => e.channelId === channel.id);

  // React Compiler memoizes these derived values; manual useMemo here fights the
  // compiler's analysis (preserve-manual-memoization), so keep them plain.
  const items = buildMessageFeed({ entries }).filter((item) => {
    if (!isMessageItem(item)) return false;
    if (dir === 'in' && item.kind !== 'message-in') return false;
    if (dir === 'out' && item.kind === 'message-in') return false;
    return true;
  });

  const byDayMap = new Map<string, ActivityFeedItem[]>();
  for (const item of items) {
    const k = dateKey(item.timestamp);
    let list = byDayMap.get(k);
    if (!list) {
      list = [];
      byDayMap.set(k, list);
    }
    list.push(item);
  }
  const byDay = Array.from(byDayMap.entries()).sort(([a], [b]) => a.localeCompare(b));

  // Settle to the newest message on first load / channel switch.
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [channel.id, items.length]);

  const loading = messageQuery.isLoading;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-surface">
      {/* Detail header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-2.5 md:px-6">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-raised/60 hover:text-text md:hidden"
          aria-label="Back to channel list"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        {channel.kind === 'dm' ? (
          <AtSign className="h-3.5 w-3.5 shrink-0 text-text-subtle" aria-hidden />
        ) : (
          <Hash className="h-3.5 w-3.5 shrink-0 text-text-subtle" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-medium text-text">
          {channelLabel(channel)}
        </span>
        {channel.status === 'muted' && (
          <span className="chrome inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-text-subtle">
            <BellOff className="h-3 w-3" aria-hidden /> Muted
          </span>
        )}
        <DirPill dir={dir} onChange={onDir} />
      </div>

      {/* Conversation */}
      <div className="flex-1 overflow-x-hidden overflow-y-auto px-4 pt-3 pb-8 md:px-6 md:pt-4">
        {messageQuery.hasNextPage && (
          <div className="flex justify-center pb-2">
            <button
              type="button"
              onClick={() => void messageQuery.fetchNextPage()}
              disabled={messageQuery.isFetchingNextPage}
              className="chrome rounded-sm border border-border-soft px-3 py-1 text-[11px] text-text-muted transition-colors hover:text-text disabled:opacity-60"
            >
              {messageQuery.isFetchingNextPage ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}
        {items.length === 0 ? (
          <div className="mt-20 text-center">
            <p className="font-serif italic text-[15px] text-text-subtle">
              {loading
                ? 'Loading conversation…'
                : dir !== 'all'
                  ? `No ${dir === 'in' ? 'inbox' : 'outbox'} messages in this channel yet.`
                  : 'No messages in this channel yet.'}
            </p>
          </div>
        ) : (
          byDay.map(([day, dayItems]) => {
            let lastTime = '';
            return (
              <DaySection key={day} date={dayItems[0]!.timestamp}>
                {dayItems.map((item, i) => {
                  const hm = clockHM(item.timestamp);
                  const time = hm === lastTime ? '' : hm;
                  lastTime = hm;
                  const key = `${day}::${i}`;
                  if (item.kind === 'message-in')
                    return (
                      <MessageInRow key={key} item={item} time={time} agentId={agentId} mode="conversation" />
                    );
                  if (item.kind === 'message-out')
                    return <MessageOutRow key={key} item={item} time={time} />;
                  if (item.kind === 'file-out')
                    return <FileOutRow key={key} item={item} time={time} agentId={agentId} />;
                  if (item.kind === 'reaction-out')
                    return <ReactOutRow key={key} item={item} time={time} />;
                  return null;
                })}
              </DaySection>
            );
          })
        )}
        <div ref={bottomRef} className="h-2" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channels view — master-detail. Selected channel lives in the URL (?c=) so the
// browser back button drives the mobile list↔detail drill for free.
// ---------------------------------------------------------------------------

export default function Channels() {
  const { agentId } = useParams<{ agentId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const now = useNow();
  const selectedId = searchParams.get('c');
  const dir = ((searchParams.get('dir') as Dir | null) ?? 'all');

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agentChannels(agentId ?? ''),
    queryFn: () => fetchAgentChannels(agentId!),
    enabled: !!agentId,
  });

  const channels = data?.channels ?? [];
  const selected = channels.find((c) => c.id === selectedId);

  function select(id: string | null) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('c', id);
        else next.delete('c');
        return next;
      },
      { replace: false },
    );
  }

  function setDir(v: Dir) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'all') next.delete('dir');
        else next.set('dir', v);
        return next;
      },
      { replace: true },
    );
  }

  if (!agentId) return null;

  return (
    <div className="flex h-full overflow-hidden bg-surface">
      {/* Master list — full width on mobile, hidden once a channel is open */}
      <aside
        className={[
          'w-full shrink-0 flex-col overflow-y-auto border-border-soft md:flex md:w-80 md:border-r',
          selected ? 'hidden md:flex' : 'flex',
        ].join(' ')}
      >
        <div className="shrink-0 border-b border-border-soft px-4 py-2.5">
          <span className="chrome text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            Channels &amp; DMs
          </span>
        </div>
        {error ? (
          <p className="px-4 py-4 font-mono text-[11px] text-health-error">Could not load channels</p>
        ) : isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-text-subtle" aria-label="Loading channels" />
          </div>
        ) : channels.length === 0 ? (
          <p className="px-4 py-6 font-serif italic text-[13px] text-text-subtle">
            Not a member of any Slack channels yet.
          </p>
        ) : (
          channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              active={channel.id === selectedId}
              now={now}
              onSelect={() => select(channel.id)}
            />
          ))
        )}
      </aside>

      {/* Detail — hidden on mobile until a channel is selected */}
      <section
        className={[
          'min-w-0 flex-1 flex-col overflow-hidden',
          selected ? 'flex' : 'hidden md:flex',
        ].join(' ')}
      >
        {selected ? (
          <ConversationPane
            agentId={agentId}
            channel={selected}
            dir={dir}
            onDir={setDir}
            onBack={() => select(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="font-serif italic text-[15px] text-text-subtle">
              Select a channel to read its conversation.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
