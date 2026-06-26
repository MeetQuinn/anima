import { useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AlertTriangle, BellOff, ChevronLeft, Loader2 } from 'lucide-react';
import { fetchAgentChannels, fetchAgentMessages, fetchAgents } from '@/api/agents';
import { buildMessageFeed, type ActivityFeedItem } from '@/lib/activity-feed';
import { agentAvatarUrl, agentDisplayName } from '@/lib/agent-avatar';
import { dateKey, formatRelativeShort } from '@/lib/format';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useNow } from '@/hooks/useNow';
import {
  groupByAuthor,
  initialOf,
  inboundAuthorName,
  isMessageItem,
  DayDivider,
  MessageGroupRow,
  type Author,
} from '../conversation/SlackTimeline';
import type { AgentChannelSummary, AgentMessageRecord } from '@shared/messages';

// Channel/DM title: a channel shows its `#` flush against the name (one token);
// a DM shows the bare handle (its avatar carries the "person" signal).
function ChannelTitle({ channel }: { channel: AgentChannelSummary }) {
  const name = channel.name ?? channel.id;
  if (channel.kind === 'dm') return <>{name}</>;
  return (
    <>
      <span className="text-text-subtle">#</span>
      {name}
    </>
  );
}

// DM counterpart avatar, with an initial-letter fallback when Slack has no image.
function DmAvatar({ channel, size = 'sm' }: { channel: AgentChannelSummary; size?: 'sm' | 'md' }) {
  const dim = size === 'md' ? 'h-6 w-6' : 'h-5 w-5';
  const initial = (channel.name ?? channel.id).trim().slice(0, 1).toUpperCase() || '?';
  if (channel.avatarUrl) {
    return (
      <img
        src={channel.avatarUrl}
        alt=""
        className={`${dim} shrink-0 rounded-full object-cover`}
        loading="lazy"
      />
    );
  }
  return (
    <span
      className={`${dim} flex shrink-0 items-center justify-center rounded-full bg-surface-raised text-[10px] font-medium text-text-subtle`}
      aria-hidden
    >
      {initial}
    </span>
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
      {channel.kind === 'dm' && <DmAvatar channel={channel} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[13px] leading-tight text-text">
          <ChannelTitle channel={channel} />
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
// Channel-scoped author resolver. The Slack-style renderer itself lives in the
// shared `conversation/SlackTimeline` module (reused by the Activity tab); this
// closure is the single-channel binding — in a DM the inbound counterpart is
// fixed, so we reuse the channel's name + avatar so the byline and the
// master-list row agree.
// ---------------------------------------------------------------------------

function authorFor(item: ActivityFeedItem, channel: AgentChannelSummary, agent: Author): Author {
  if (item.kind !== 'message-in') return agent;
  const name = inboundAuthorName(item.event);
  // In a DM the counterpart is fixed — reuse the row's resolved name + avatar so
  // the byline and the master-list row agree.
  if (channel.kind === 'dm') {
    const dmName = channel.name ?? name;
    return {
      key: `dm:${channel.id}`,
      name: dmName,
      ...(channel.avatarUrl ? { avatarUrl: channel.avatarUrl } : {}),
      initial: initialOf(dmName),
      isAgent: false,
    };
  }
  const uid = item.event.kind === 'slack' ? item.event.actor?.userId : undefined;
  return {
    key: `in:${uid ?? name}`,
    name,
    // Sender's real Slack avatar when resolved by the /messages enrichment
    // (same source as the Activity tab, so avatars are identical across both);
    // falls back to the initial when absent.
    ...(item.avatarUrl ? { avatarUrl: item.avatarUrl } : {}),
    initial: initialOf(name),
    isAgent: false,
  };
}

// ---------------------------------------------------------------------------
// Detail pane: one channel's conversation. Fetches this channel's history
// server-side (scoped via ?channel=), so paging loads only this conversation
// rather than the whole agent stream filtered client-side. Reuses the shared
// message-feed normalization and Slack-style renderer. One unified timeline
// (no inbox/outbox split — the direction split isn't meaningful per channel).
// ---------------------------------------------------------------------------

function ConversationPane({
  agentId,
  channel,
  onBack,
}: {
  agentId: string;
  channel: AgentChannelSummary;
  onBack: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // The agent's own avatar/name byline its outbound messages, Slack-style.
  const agentsQuery = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const agentSnapshot = agentsQuery.data?.find((a) => a.id === agentId);
  const agentAuthor: Author = {
    key: 'agent',
    name: agentSnapshot ? agentDisplayName(agentSnapshot) : agentId,
    ...(agentAvatarUrl(agentSnapshot) ? { avatarUrl: agentAvatarUrl(agentSnapshot)! } : {}),
    initial: initialOf(agentSnapshot ? agentDisplayName(agentSnapshot) : agentId),
    isAgent: true,
  };

  const messageQuery = useInfiniteQuery({
    queryKey: queryKeys.agentChannelMessages(agentId, channel.id),
    queryFn: ({ pageParam }) =>
      fetchAgentMessages(agentId, { before: pageParam, channel: channel.id, limit: 200 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: refetchIntervals.agentActivities,
  });

  // Merge loaded pages and dedupe. The server already scopes to this channel, so
  // no client-side channel filter is needed. The React Compiler memoizes these
  // derived values; manual useMemo here fights its analysis
  // (preserve-manual-memoization), so keep them plain.
  const entryMap = new Map<string, AgentMessageRecord>();
  for (const page of messageQuery.data?.pages ?? []) {
    for (const entry of page.entries ?? []) entryMap.set(entry.messageId, entry);
  }
  const entries = Array.from(entryMap.values());

  const items = buildMessageFeed({ entries }).filter(isMessageItem);

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
      {/* Detail header. Fixed h-11 so it lines up exactly with the master-list
          header across panes, regardless of DM avatar / muted-pill content. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-soft px-4 md:px-6">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-raised/60 hover:text-text md:hidden"
          aria-label="Back to channel list"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        {channel.kind === 'dm' && <DmAvatar channel={channel} size="md" />}
        <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-medium text-text">
          <ChannelTitle channel={channel} />
        </span>
        {channel.status === 'muted' && (
          <span className="chrome inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-text-subtle">
            <BellOff className="h-3 w-3" aria-hidden /> Muted
          </span>
        )}
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
              {loading ? 'Loading conversation…' : 'No messages in this channel yet.'}
            </p>
          </div>
        ) : (
          byDay.map(([day, dayItems]) => (
            <div key={day}>
              <DayDivider iso={dayItems[0]!.timestamp} />
              {groupByAuthor(dayItems, (item) => authorFor(item, channel, agentAuthor)).map(
                (group, gi) => (
                  <MessageGroupRow key={`${day}::${gi}`} group={group} agentId={agentId} />
                ),
              )}
            </div>
          ))
        )}
        <div ref={bottomRef} className="h-2" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channels view: master-detail. Selected channel lives in the URL (?c=) so the
// browser back button drives the mobile list↔detail drill for free.
// ---------------------------------------------------------------------------

export default function Channels() {
  const { agentId } = useParams<{ agentId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const now = useNow();
  const selectedId = searchParams.get('c');

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agentChannels(agentId ?? ''),
    queryFn: () => fetchAgentChannels(agentId!),
    enabled: !!agentId,
    // The membership list is cheap to serve (cache-first on the backend) and
    // changes rarely. Keep it warm so re-entering the tab paints instantly from
    // cache and revalidates in the background, and keep showing the old list
    // while a refetch is in flight rather than flashing the spinner.
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const channels = data?.channels ?? [];
  const selected = channels.find((c) => c.id === selectedId);
  const firstChannelId = channels[0]?.id;

  // On desktop, auto-open the most recent channel (the list is sorted by recency)
  // instead of resting on the empty state. Mobile keeps the list-first drill so
  // the membership list, the whole point of the tab, is what you land on.
  useEffect(() => {
    if (selectedId || !firstChannelId) return;
    if (!window.matchMedia('(min-width: 768px)').matches) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('c', firstChannelId);
        return next;
      },
      { replace: true },
    );
  }, [selectedId, firstChannelId, setSearchParams]);

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

  if (!agentId) return null;

  return (
    <div className="flex h-full overflow-hidden bg-surface">
      {/* Master list: full width on mobile, hidden once a channel is open */}
      <aside
        className={[
          'w-full shrink-0 flex-col overflow-y-auto border-border-soft md:flex md:w-64 md:border-r',
          selected ? 'hidden md:flex' : 'flex',
        ].join(' ')}
      >
        <div className="flex h-11 shrink-0 items-center border-b border-border-soft px-4">
          <span className="chrome text-[11px] font-medium uppercase tracking-[0.12em] text-text-muted">
            Channels &amp; DMs
          </span>
        </div>
        {data?.membershipPartial && (
          <div className="flex shrink-0 items-start gap-1.5 border-b border-border-soft bg-health-error/5 px-4 py-2">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-health-error" aria-hidden />
            <p className="font-sans text-[11px] leading-snug text-text-muted">
              Couldn&apos;t reach Slack. Showing subscription history only, so this
              list may be missing silent member channels.
            </p>
          </div>
        )}
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

      {/* Detail: hidden on mobile until a channel is selected */}
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
            onBack={() => select(null)}
          />
        ) : selectedId ? (
          // Deep-linked (e.g. from an Activity surface chip) to a channel that
          // isn't in the membership list — the agent may have left it, or it's a
          // surface with no Channels detail target. Stay honest rather than
          // silently resting on the first channel.
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="max-w-prose font-serif italic text-[15px] text-text-subtle">
              That conversation isn&apos;t in this list. The agent may have left the channel,
              or it has no history here. Pick one from the list to read it.
            </p>
          </div>
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
