import { useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { AlertTriangle, BellOff, ChevronLeft, Loader2, SmilePlus } from 'lucide-react';
import { fetchAgentChannels, fetchAgentMessages, fetchAgents } from '@/api/agents';
import { buildMessageFeed, type ActivityFeedItem } from '@/lib/activity-feed';
import { renderMrkdwn } from '@/lib/mrkdwn';
import { agentAvatarUrl, agentDisplayName } from '@/lib/agent-avatar';
import { clockHM, dateKey, dateLabel, formatRelativeShort } from '@/lib/format';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useNow } from '@/hooks/useNow';
import { AttachedFiles, UploadedFile } from '../activity/Attachments';
import type { InboxItem } from '@shared/inbox';
import type { AgentChannelSummary, AgentMessageRecord } from '@shared/messages';
import type { SlackFile } from '@/types';

type Dir = 'all' | 'in' | 'out';

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
// Slack-style conversation renderer
//
// totoday round-2 ask: read the conversation like Slack, not like the Activity
// audit register. So messages sit left-aligned with an author avatar + name +
// time, consecutive same-author messages collapse under one header, and day
// dividers separate the stream. Read-only (no composer). We still consume the
// shared `ActivityFeedItem` normalization (buildMessageFeed) so the in→file /
// out→file mapping stays in one tested place; this layer is presentation only.
// ---------------------------------------------------------------------------

const GROUP_GAP_MS = 5 * 60 * 1000; // start a fresh author block after a 5-min lull

interface Author {
  key: string; // groups consecutive messages
  name: string;
  avatarUrl?: string;
  initial: string;
  isAgent: boolean;
}

function initialOf(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

// Inbound author byline (Slack only in v1; other kinds degrade to a label).
function inboundAuthorName(event: InboxItem): string {
  if (event.kind === 'slack') {
    return (
      event.actor?.displayName ||
      event.actor?.realName ||
      event.actor?.handle?.replace(/^@/, '') ||
      event.actor?.userId ||
      'Unknown user'
    );
  }
  if (event.kind === 'feishu') {
    return event.actor?.displayName || event.actor?.openId || event.actor?.userId || 'Feishu user';
  }
  if (event.kind === 'choice_response') return event.answeredBy.handle?.replace(/^@/, '') || event.answeredBy.displayName || 'Choice response';
  if (event.kind === 'reminder') return event.title?.trim() || 'Reminder';
  if (event.kind === 'memory_coherence') return 'Memory coherence';
  return 'Onboarding';
}

function inboundText(event: InboxItem): string {
  if (event.kind === 'reminder' || event.kind === 'memory_coherence') return '';
  if (event.kind === 'choice_response') return `Selected: ${event.optionLabel}`;
  return ('text' in event ? event.text : '') ?? '';
}

function inboundFiles(event: InboxItem): SlackFile[] {
  if (event.kind === 'slack' || event.kind === 'feishu') {
    return (event.files ?? []) as SlackFile[];
  }
  return [];
}

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
  return { key: `in:${uid ?? name}`, name, initial: initialOf(name), isAgent: false };
}

function MsgAvatar({ author }: { author: Author }) {
  if (author.avatarUrl) {
    return (
      <img
        src={author.avatarUrl}
        alt=""
        className="h-9 w-9 shrink-0 rounded-md object-cover"
        loading="lazy"
      />
    );
  }
  return (
    <span
      className={[
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[13px] font-semibold',
        author.isAgent ? 'bg-accent/15 text-accent' : 'bg-surface-raised text-text-muted',
      ].join(' ')}
      aria-hidden
    >
      {author.initial}
    </span>
  );
}

// One message's content (text + files), avatar/byline handled by the group.
function MessageBody({ item, agentId }: { item: ActivityFeedItem; agentId: string }) {
  if (item.kind === 'message-in') {
    const text = inboundText(item.event).trim();
    const files = inboundFiles(item.event);
    return (
      <>
        {text && (
          <div className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-text">
            {renderMrkdwn(text)}
          </div>
        )}
        {files.length > 0 && <AttachedFiles files={files} agentId={agentId} />}
      </>
    );
  }
  if (item.kind === 'message-out') {
    const text = item.text.trim();
    if (!text) return <span className="font-serif text-[13px] italic text-text-subtle">(empty message)</span>;
    return (
      <div className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-text">
        {renderMrkdwn(text)}
      </div>
    );
  }
  if (item.kind === 'file-out') {
    const caption = item.caption.trim();
    return (
      <>
        {caption && (
          <div className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-text">
            {renderMrkdwn(caption)}
          </div>
        )}
        <div className="mt-1 flex flex-wrap gap-2">
          {item.files.map((file) => (
            <UploadedFile key={file.fileId} file={file} agentId={agentId} />
          ))}
        </div>
      </>
    );
  }
  if (item.kind !== 'reaction-out') return null;
  // reaction-out: a lightweight signal, not a full message.
  const verb = item.action === 'removed' ? 'removed reaction' : 'reacted';
  return (
    <span className="inline-flex items-center gap-1.5 font-sans text-[13px] text-text-muted">
      <SmilePlus className="h-3.5 w-3.5 text-text-subtle" aria-hidden />
      {verb}
      {item.emoji && (
        <code className="rounded-sm bg-surface-raised px-1 py-0.5 text-[12px] text-text-muted">
          :{item.emoji}:
        </code>
      )}
    </span>
  );
}

// A run of consecutive messages from one author: avatar + byline once, bodies
// stacked beneath (the Slack grouping rhythm).
interface MessageGroup {
  author: Author;
  startTs: string;
  items: { item: ActivityFeedItem; key: string }[];
}

function groupByAuthor(
  items: ActivityFeedItem[],
  channel: AgentChannelSummary,
  agent: Author,
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const author = authorFor(item, channel, agent);
    const tsMs = Date.parse(item.timestamp);
    const last = groups[groups.length - 1];
    const lastMs = last ? Date.parse(last.startTs) : 0;
    const continues =
      last &&
      last.author.key === author.key &&
      Number.isFinite(tsMs) &&
      tsMs - Date.parse(last.items[last.items.length - 1]!.item.timestamp) <= GROUP_GAP_MS &&
      Number.isFinite(lastMs);
    if (continues) {
      last!.items.push({ item, key: `${i}` });
    } else {
      groups.push({ author, startTs: item.timestamp, items: [{ item, key: `${i}` }] });
    }
  }
  return groups;
}

function DayDivider({ iso }: { iso: string }) {
  return (
    <div className="my-3 flex items-center gap-3">
      <span className="h-px flex-1 bg-border-soft" />
      <span className="chrome rounded-full border border-border-soft bg-surface px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-text-subtle">
        {dateLabel(iso)}
      </span>
      <span className="h-px flex-1 bg-border-soft" />
    </div>
  );
}

function MessageGroupRow({
  group,
  agentId,
}: {
  group: MessageGroup;
  agentId: string;
}) {
  return (
    <div className="flex gap-2.5 px-1 py-1.5">
      <MsgAvatar author={group.author} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-sans text-[13px] font-semibold text-text">
            {group.author.name}
          </span>
          <span className="shrink-0 font-sans text-[11px] text-text-subtle">
            {clockHM(group.startTs)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-col gap-1">
          {group.items.map(({ item, key }) => (
            <MessageBody key={key} item={item} agentId={agentId} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail pane: one channel's conversation. Reuses the shared message-feed
// normalization; renders Slack-style and filters the global feed to the
// selected channel (server has no per-channel route in v1; client-side per spec).
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
        {channel.kind === 'dm' && <DmAvatar channel={channel} size="md" />}
        <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-medium text-text">
          <ChannelTitle channel={channel} />
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
          byDay.map(([day, dayItems]) => (
            <div key={day}>
              <DayDivider iso={dayItems[0]!.timestamp} />
              {groupByAuthor(dayItems, channel, agentAuthor).map((group, gi) => (
                <MessageGroupRow key={`${day}::${gi}`} group={group} agentId={agentId} />
              ))}
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
  const dir = ((searchParams.get('dir') as Dir | null) ?? 'all');

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agentChannels(agentId ?? ''),
    queryFn: () => fetchAgentChannels(agentId!),
    enabled: !!agentId,
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
      {/* Master list: full width on mobile, hidden once a channel is open */}
      <aside
        className={[
          'w-full shrink-0 flex-col overflow-y-auto border-border-soft md:flex md:w-64 md:border-r',
          selected ? 'hidden md:flex' : 'flex',
        ].join(' ')}
      >
        <div className="shrink-0 border-b border-border-soft px-4 py-2.5">
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
