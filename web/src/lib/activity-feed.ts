// Build a flat chronological activity feed for a single agent.
// No channel/thread clustering — users routinely jump between channel
// top-level and threads in the same conversation, so grouping fragments the
// natural reading flow. Each row carries its own Slack place chip; the visual
// rhythm comes from typography + day separators.

import type { Activity as ActivityRecord, AgentActivityFeedPage } from '@shared/activity';
import type { AgentMessageHistoryPage, AgentMessageRecord } from '@shared/messages';
import { classifyOutboundEffect } from '@shared/outbound-effects';
import { isRuntimeEventNoise } from '@shared/runtime-event-noise';

// Hidden by default. Toggled on by "show all steps".
//   - runtime.* are spawn-lifecycle plumbing
//   - follow-up append records are lifecycle plumbing
const HIDDEN_TYPES: ReadonlySet<string> = new Set([
  'runtime.started',
  'runtime.output',
  'runtime.followup_appended',
  'runtime.steered',
  'runtime.pending',
  'runtime.steer_failed',
]);

const DUPLICATE_AGENT_TEXT_WINDOW_MS = 10_000;

interface RecentOutboundText {
  text: string;
  timestampMs: number;
}

// Provider protocol frames are filtered in TWO layers:
//   Always hidden (even in show-all): raw streaming internals — `.stream.*`,
//     `.reasoning.*`, `.content.part`, `.tool.call.part`, etc. These produce
//     thousands of rows with no diagnostic value (the 21k `claude.stream.
//     message_stop` case, iris #49 round-2 scope). This predicate is the
//     shared `isRuntimeEventNoise` from `@shared/runtime-event-noise` — the
//     same list the server uses on the write side (shouldPersistRuntimeEvent),
//     so read-side hiding and write-side suppression can no longer drift.
//   Default-hidden, visible in show-all: meaningful lifecycle plumbing —
//     HIDDEN_TYPES (runtime.started/output/followup/pending/legacy steer) +
//     session stats / compact / rate-limit / model-routing events. These
//     surface when showHidden=true so the user can trace execution.

function activityProviderToolId(activity: ActivityRecord): string | undefined {
  return typeof activity.payload?.['providerToolId'] === 'string'
    ? activity.payload['providerToolId']
    : undefined;
}

function isWebSearchActivity(activity: ActivityRecord): boolean {
  const payload = activity.payload ?? {};
  const tool = String(payload['tool'] ?? '').toLowerCase();
  const providerToolName = String(payload['providerToolName'] ?? '').toLowerCase();
  return tool === 'codex.websearch' || providerToolName === 'websearch';
}

function hasWebSearchDisplayDetails(activity: ActivityRecord): boolean {
  const payload = activity.payload ?? {};
  return ['target', 'query', 'url', 'pattern'].some((key) => {
    const value = payload[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

export interface SurfaceChip {
  kind: 'channel' | 'thread' | 'dm' | 'reminder' | 'onboarding';
  label: string;
  // Slack channel/DM id (C…/D…) when the chip maps to a real conversation. The
  // Activity timeline renders the chip as a link to that channel in the Channels
  // tab (`?c=<channelId>`). Absent for reminder / onboarding / unknown surfaces,
  // which have no channel to open.
  channelId?: string;
}

export interface OutboundFile {
  fileId: string;
  filename: string;
  mimetype: string;
  permalink?: string;
  sizeBytes: number;
  thumb360?: string;
  thumb720?: string;
}

export interface SubagentStream {
  subRunId: string;
  name?: string;
  role?: string;
  model?: string;
  depth: number;
  items: ActivityFeedItem[];
}

export type ActivityFeedItem =
  | {
      kind: 'message-in';
      // The ledger record itself. Renderers (SlackTimeline, author resolvers)
      // read author identity / text / files / previews straight off it.
      message: AgentMessageRecord;
      timestamp: string;
      surface: SurfaceChip;
      // Inbound sender's Slack avatar (image_72), resolved best-effort by the
      // /messages route. Absent → the author resolver falls back to an initial.
      avatarUrl?: string;
    }
  | {
      kind: 'message-out';
      text: string;
      // Jump-to-Slack link for the sent message, when the backend recorded it.
      permalink?: string;
      timestamp: string;
      surface: SurfaceChip;
      isEdit: boolean;
    }
  | {
      kind: 'file-out';
      caption: string;
      files: OutboundFile[];
      permalink?: string;
      timestamp: string;
      surface: SurfaceChip;
    }
  | {
      // React is outbound voice but a lighter weight than message/file — it
      // doesn't carry text content, just a one-shot signal. Rendered as a
      // byline trace (accent dot, no margin pull-rule) so reaction rows show
      // the specific reaction without looking like full message rows.
      kind: 'reaction-out';
      action: 'added' | 'removed';
      emoji: string;
      noop: boolean;
      timestamp: string;
      surface: SurfaceChip;
    }
  | { kind: 'step'; activity: ActivityRecord; timestamp: string; subagentStreams?: SubagentStream[] }
  | {
      // System-originated wake (reminder / onboarding) — not a message anyone
      // sent. Rendered as a centered, avatar-less system line so it reads as a
      // timeline annotation rather than competing with real conversation. The
      // memory-coherence pass is NOT here: it is a `memory_coherence.outcome`
      // activity rendered in the tool-steps lane, never the conversation layer.
      kind: 'system-event';
      eventKind: 'reminder' | 'onboarding' | 'attention';
      label: string; // small-caps register label ('Reminder' | 'Onboarding')
      body: string; // muted descriptive line (reminder title / onboarding note)
      meta?: string; // optional trailing tag, e.g. recurring 'fire #3'
      timestamp: string;
    };

// Map an inbound ledger record to a system-event timeline item when it is a
// system wake (reminder / onboarding) rather than a person's message. Returns
// null for real messages (slack/feishu) and for choice_response — a user's
// explicit selection, which stays on the message side.
function systemEventForMessage(
  message: AgentMessageRecord,
): Extract<ActivityFeedItem, { kind: 'system-event' }> | null {
  if (isOnboardingWakeMessage(message)) {
    // Collapse to a short fixed label - the raw onboarding prompt is long and
    // internal, so it should not be exposed in the timeline.
    return {
      kind: 'system-event',
      eventKind: 'onboarding',
      label: 'Onboarding',
      body: 'Agent onboarding started',
      timestamp: message.timestamp,
    };
  }
  if (message.kind === 'reminder') {
    return {
      kind: 'system-event',
      eventKind: 'reminder',
      label: 'Reminder',
      body: message.reminderTitle?.trim() || 'Reminder fired',
      timestamp: message.timestamp,
    };
  }
  return null;
}

export function buildActivityFeed(
  activityFeed: AgentActivityFeedPage,
  showHidden = false,
): ActivityFeedItem[] {
  const activities = activityFeed.events;

  // Pre-scan: group child activities (those with parentToolCallId) by parentId → subRunId.
  // These are skipped from the flat feed and attached to their parent step row instead.
  const childrenByProviderToolId = new Map<string, Map<string, ActivityRecord[]>>();
  for (const activity of activities) {
    const parentId =
      typeof activity.payload?.['parentToolCallId'] === 'string'
        ? activity.payload['parentToolCallId']
        : undefined;
    if (!parentId) continue;
    const subRunId =
      typeof activity.payload?.['subRunId'] === 'string'
        ? activity.payload['subRunId']
        : '__default__';
    if (!childrenByProviderToolId.has(parentId)) {
      childrenByProviderToolId.set(parentId, new Map());
    }
    const byRun = childrenByProviderToolId.get(parentId)!;
    const existing = byRun.get(subRunId) ?? [];
    existing.push(activity);
    byRun.set(subRunId, existing);
  }

  // Newer Codex app-server builds can emit `item/started` for a webSearch
  // before the query is known, then the query appears later in the session
  // JSONL's `web_search_end`. The backend appends a detailed row with the same
  // providerToolId, so suppress the earlier blank started row here.
  const detailedWebSearchProviderToolIds = new Set<string>();
  for (const activity of activities) {
    if (activity.type !== 'tool.call.started') continue;
    if (!isWebSearchActivity(activity) || !hasWebSearchDisplayDetails(activity)) continue;
    const id = activityProviderToolId(activity);
    if (id) detailedWebSearchProviderToolIds.add(id);
  }

  const items: ActivityFeedItem[] = [];
  const recentOutboundTexts: RecentOutboundText[] = [];

  // Activities
  for (const activity of activities) {
    // Child activities are attached to their parent step row — skip from flat feed.
    if (typeof activity.payload?.['parentToolCallId'] === 'string') continue;

    if (
      activity.type === 'tool.call.started' &&
      isWebSearchActivity(activity) &&
      !hasWebSearchDisplayDetails(activity)
    ) {
      const id = activityProviderToolId(activity);
      if (id && detailedWebSearchProviderToolIds.has(id)) continue;
    }

    if (activity.type === 'runtime.steer_failed') continue;

    if (activity.type === 'anima.attention.suggestion') {
      items.push(systemEventForAttentionSuggestion(activity));
      continue;
    }

    // External message/file/reaction effects → outbound feed items. The
    // (tool, effect) → kind decision lives in the shared classifier so the
    // web feed and the server's ledger projection can never drift.
    if (activity.type === 'tool.call.completed' || activity.type === 'external.effect.completed') {
      const payload = activity.payload ?? {};
      const tool = typeof payload['tool'] === 'string' ? payload['tool'] : undefined;
      const effect = typeof payload['effect'] === 'string' ? payload['effect'] : undefined;
      const classified = classifyOutboundEffect({ effect, tool });
      if (classified?.kind === 'message') {
        const text = payload['text'];
        const permalink =
          typeof payload['permalink'] === 'string' && payload['permalink']
            ? payload['permalink']
            : undefined;
        items.push({
          kind: 'message-out',
          text: typeof text === 'string' ? text : '',
          ...(permalink ? { permalink } : {}),
          timestamp: activity.createdAt,
          surface: surfaceChipForOutbound(activity),
          isEdit: classified.isEdit,
        });
        rememberOutboundText(recentOutboundTexts, activity);
        continue;
      }
      if (classified?.kind === 'file') {
        const caption = typeof payload['caption'] === 'string' ? payload['caption'] : '';
        const permalink =
          typeof payload['permalink'] === 'string' ? payload['permalink'] : undefined;
        const files = outboundFilesFromPayload(payload['uploads']);
        items.push({
          kind: 'file-out',
          caption,
          files,
          ...(permalink ? { permalink } : {}),
          timestamp: activity.createdAt,
          surface: surfaceChipForOutbound(activity),
        });
        continue;
      }
      if (tool === 'anima.reminder.fire') {
        // Consumed by the message-in row for this item (see pre-scan above).
        // Suppress as a standalone step — it would otherwise double-render
        // alongside the reminder wake byline.
        continue;
      }
      if (classified?.kind === 'reaction') {
        const action: 'added' | 'removed' = payload['action'] === 'removed' ? 'removed' : 'added';
        const emoji = typeof payload['name'] === 'string' ? payload['name'] : '';
        const noop = payload['noop'] === true;
        items.push({
          kind: 'reaction-out',
          action,
          emoji,
          noop,
          timestamp: activity.createdAt,
          surface: surfaceChipForOutbound(activity),
        });
        continue;
      }
    }

    if (isDuplicateAgentText(activity, recentOutboundTexts)) continue;

    // The corresponding "started" event for Anima CLI and external effects is
    // uninteresting noise (just "I'm about to send"). The completed row
    // becomes the outbound item.
    if (
      activity.type === 'tool.call.started' ||
      activity.type === 'tool.call.completed' ||
      activity.type === 'external.effect.started'
    ) {
      const payload = activity.payload ?? {};
      const tool = String(payload['tool'] ?? '');
      // anima.* CLI tools emit both started + completed. Drop started to
      // avoid duplicate rows; the completed event carries the outcome.
      if (activity.type === 'external.effect.started') continue;
      if (activity.type === 'tool.call.started' && tool.startsWith('anima.')) continue;
      // Codex invokes the anima CLI via the shell tool — skip that wrapper
      // step, since the CLI's own events surface the meaningful action.
      // Providers spell the same tool differently: Codex emits 'shell',
      // Claude Code emits 'Bash' (capital — see src/providers/provider-events.ts).
      // Compare lower-cased so both get dedup'd; otherwise the wrapper row
      // double-renders alongside its anima.* effect row.
      const providerName = String(payload['providerToolName'] ?? '').toLowerCase();
      if (providerName === 'shell' || providerName === 'bash') {
        const cmd = String(payload['command'] ?? payload['target'] ?? '').trim();
        // anima CLI commands are replaced by their own semantic activity rows.
        if (
          /^(\/\S*sh\s+-l?c\s+['"])?\s*anima\s+(message|file|reminder|follow|subscription|ask)\b/.test(
            cmd,
          )
        )
          continue;
      }
    }

    // Provider protocol frames (raw streaming internals: `.stream.*`,
    // `.reasoning.*`, `.content.part`, etc.) are filtered in BOTH modes.
    // They produce tens of thousands of rows without debug value — the
    // 21k `claude.stream.message_stop` case (#49 iris round-2). The
    // HIDDEN_TYPES tier (runtime.started, runtime.output, follow-up append,
    // runtime.pending, legacy steer records) is meaningful lifecycle plumbing
    // that Show all steps does expose.
    if (activity.type === 'runtime.event') {
      if (isRuntimeEventNoise(String(activity.payload?.['eventType'] ?? ''))) continue;
    } else if (!showHidden && HIDDEN_TYPES.has(activity.type)) {
      continue;
    }

    // Attach subagent streams to the parent step row when this activity's
    // providerToolId has matching children.
    const providerToolId =
      typeof activity.payload?.['providerToolId'] === 'string'
        ? activity.payload['providerToolId']
        : undefined;
    const childByRun = providerToolId ? childrenByProviderToolId.get(providerToolId) : undefined;
    const subagentStreams = childByRun ? buildSubagentStreams(childByRun, showHidden) : undefined;
    items.push({
      kind: 'step',
      activity,
      timestamp: activity.createdAt,
      ...(subagentStreams ? { subagentStreams } : {}),
    });
  }

  // Sort by timestamp ASC (oldest first). When rows share a timestamp, keep
  // outbound/user-visible work ahead of runtime closure rows so `IDLE` cannot
  // visually appear before the action that completed the item.
  items.sort((a, b) => {
    const byTime = a.timestamp.localeCompare(b.timestamp);
    if (byTime !== 0) return byTime;
    return activityFeedSortRank(a) - activityFeedSortRank(b);
  });
  return items;
}

function systemEventForAttentionSuggestion(
  activity: ActivityRecord,
): Extract<ActivityFeedItem, { kind: 'system-event' }> {
  const suggestion =
    typeof activity.payload?.['suggestion'] === 'string'
      ? activity.payload['suggestion']
      : 'Attention suggestion attached';
  const platform =
    typeof activity.payload?.['platform'] === 'string'
      ? activity.payload['platform']
      : '';
  const channelName =
    typeof activity.payload?.['channelName'] === 'string'
      ? activity.payload['channelName']
      : '';
  const channelId =
    typeof activity.payload?.['channelId'] === 'string'
      ? activity.payload['channelId']
      : '';
  const threadTs =
    typeof activity.payload?.['threadTs'] === 'string'
      ? activity.payload['threadTs']
      : '';
  const surface = surfaceLabelForAttentionSuggestion({ channelId, channelName, platform });
  return {
    kind: 'system-event',
    eventKind: 'attention',
    label: 'Attention',
    body: threadTs ? `${surface} · thread suggestion attached` : `${surface} suggestion attached`,
    meta: suggestion,
    timestamp: activity.createdAt,
  };
}

function surfaceLabelForAttentionSuggestion(input: {
  channelId: string;
  channelName: string;
  platform: string;
}): string {
  if (input.channelName) {
    return input.platform === 'slack'
      ? `#${input.channelName.replace(/^#/, '')}`
      : input.channelName;
  }
  if (input.channelId) {
    return input.platform === 'feishu' ? `Feishu ${input.channelId}` : input.channelId;
  }
  return input.platform === 'feishu' ? 'Feishu chat' : 'conversation';
}

export function buildMessageFeed(messagePage: AgentMessageHistoryPage): ActivityFeedItem[] {
  const items: ActivityFeedItem[] = [];
  for (const message of messagePage.entries) {
    if (message.direction === 'in') {
      const systemEvent = systemEventForMessage(message);
      if (systemEvent) {
        items.push(systemEvent);
        continue;
      }
      items.push({
        kind: 'message-in',
        message,
        timestamp: message.timestamp,
        surface: surfaceChipForInboundMessage(message),
        ...(message.actorAvatarUrl ? { avatarUrl: message.actorAvatarUrl } : {}),
      });
      continue;
    }
    if (message.kind === 'message') {
      items.push({
        kind: 'message-out',
        text: message.text,
        ...(message.permalink ? { permalink: message.permalink } : {}),
        timestamp: message.timestamp,
        surface: surfaceChipForOutboundMessage(message),
        isEdit: message.isEdit === true,
      });
      continue;
    }
    if (message.kind === 'file') {
      items.push({
        kind: 'file-out',
        caption: message.text.split(/\r?\nFiles:/)[0] ?? '',
        files: (message.files ?? []).map((file, index) => ({
          fileId: file.fileId ?? `${message.messageId}:file:${index}`,
          filename: file.filename,
          mimetype: file.mimetype ?? 'application/octet-stream',
          ...(file.permalink ? { permalink: file.permalink } : {}),
          sizeBytes: file.sizeBytes ?? 0,
          ...(file.thumb360 ? { thumb360: file.thumb360 } : {}),
          ...(file.thumb720 ? { thumb720: file.thumb720 } : {}),
        })),
        ...(message.permalink ? { permalink: message.permalink } : {}),
        timestamp: message.timestamp,
        surface: surfaceChipForOutboundMessage(message),
      });
      continue;
    }
    if (message.kind === 'reaction') {
      items.push({
        kind: 'reaction-out',
        action: message.reaction?.action ?? 'added',
        emoji: message.reaction?.name ?? '',
        noop: message.reaction?.noop === true,
        timestamp: message.timestamp,
        surface: surfaceChipForOutboundMessage(message),
      });
    }
  }
  return items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function activityFeedSortRank(item: ActivityFeedItem): number {
  if (item.kind === 'message-in') return 0;
  if (item.kind === 'message-out' || item.kind === 'file-out' || item.kind === 'reaction-out')
    return 1;
  if (item.kind === 'step' && item.activity.type === 'runtime.completed') return 3;
  return 2;
}

function outboundFilesFromPayload(uploads: unknown): OutboundFile[] {
  if (!Array.isArray(uploads)) return [];
  return uploads.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    const fileId = typeof r['fileId'] === 'string' ? r['fileId'] : '';
    const filename = typeof r['filename'] === 'string' ? r['filename'] : '';
    if (!fileId || !filename) return [];
    return [
      {
        fileId,
        filename,
        mimetype: typeof r['mimetype'] === 'string' ? r['mimetype'] : 'application/octet-stream',
        sizeBytes: typeof r['sizeBytes'] === 'number' ? r['sizeBytes'] : 0,
        ...(typeof r['permalink'] === 'string' ? { permalink: r['permalink'] } : {}),
        ...(typeof r['thumb360'] === 'string' ? { thumb360: r['thumb360'] } : {}),
        ...(typeof r['thumb720'] === 'string' ? { thumb720: r['thumb720'] } : {}),
      },
    ];
  });
}

// --- surface chip derivation ---------------------------------------------

// DM chip label: `@` + the handle with any leading `@` stripped, so a stored
// `@alice` never renders as `@@alice`. One home for the idiom that was
// previously copy-pasted across the chip builders.
function dmLabel(handle: string): string {
  return `@${handle.replace(/^@/, '')}`;
}

function surfaceChipForInboundMessage(message: AgentMessageRecord): SurfaceChip {
  if (isOnboardingWakeMessage(message)) return { kind: 'onboarding', label: 'Onboarding' };
  if (message.kind === 'reminder') {
    return { kind: 'reminder', label: 'Reminder' };
  }
  if (message.kind === 'choice_response') return surfaceChipForChoiceMessage(message);
  if (message.platform === 'feishu') return surfaceChipForFeishuMessage(message);
  return surfaceChipForSlackMessage(message);
}

// A system wake recorded in the ledger as an onboarding pass — either typed as
// one, or an inbox-sourced record whose original inbox id carries the
// `agent-onboarding:` prefix (older records predate the dedicated kind).
function isOnboardingWakeMessage(message: AgentMessageRecord): boolean {
  if (message.kind === 'onboarding') return true;
  const sourceId = message.source.kind === 'inbox' ? message.source.id : message.messageId;
  return sourceId.startsWith('agent-onboarding:');
}

// Chip label rules (iris-locked 1779212784.593679, "Option A"):
//   • Drop "Channel · " / "Thread · " / "DM · " prefixes — `#`/`@` already
//     conveys the kind, hashtag-prefixing the word "Channel"/"Thread" made
//     them read as pseudo-channel-names.
//   • Outbound rows carry threadedness in the *title* (e.g. "Replied in
//     thread") — see Stream.tsx outbound rows — so the chip stays clean as
//     just `#prod`.
//   • Inbound rows have no verb-led title (byline = actor name), so the
//     thread signal survives as a lowercase " · thread" prose suffix on the
//     chip itself. Asymmetric vs outbound but each register puts threaded-
//     ness in its own reading-flow slot.

function surfaceChipForSlackMessage(message: AgentMessageRecord): SurfaceChip {
  const channelId = message.channelId ?? '';
  const channelName = message.channelName;
  const threadTs = message.threadTs;
  const kind = channelId.startsWith('D') ? 'dm' : threadTs ? 'thread' : 'channel';
  // Fall back to the raw channel id rather than "Unknown channel" — the id is
  // real data and at least lets the user look it up; the string literal
  // was a debugging placeholder that leaked into the UI (round-2 item 3).
  const channel = channelName ? `#${channelName}` : channelId;
  // Carry the real channel id so the Activity timeline can link the chip to the
  // Channels tab. Omit the placeholder so an unknown surface stays non-clickable
  // rather than linking to nowhere (iris's honest-degrade bar).
  const target = message.channelId ? { channelId: message.channelId } : {};
  if (kind === 'dm') {
    const handle = message.actorHandle || message.actorDisplayName;
    return { kind: 'dm', label: handle ? dmLabel(handle) : 'DM', ...target };
  }
  if (kind === 'thread') return { kind: 'thread', label: `${channel} · thread`, ...target };
  return { kind: 'channel', label: channel, ...target };
}

function surfaceChipForFeishuMessage(message: AgentMessageRecord): SurfaceChip {
  const chatType = message.channelKind ?? 'group';
  const label = chatType === 'p2p' ? 'Feishu DM' : `Feishu ${chatType || 'chat'}`;
  if (message.threadTs) return { kind: 'thread', label: `${label} · topic` };
  if (chatType === 'p2p') return { kind: 'dm', label };
  return { kind: 'channel', label };
}

function surfaceChipForChoiceMessage(message: AgentMessageRecord): SurfaceChip {
  const channelId = message.channelId ?? '';
  const channelName = message.channelName;
  const threadTs = message.threadTs;
  const kind = channelId.startsWith('D') ? 'dm' : threadTs ? 'thread' : 'channel';
  const channel = channelName
    ? channelName.startsWith('#') ? channelName : `#${channelName}`
    : channelId;
  if (kind === 'dm') {
    const handle = message.actorHandle || message.actorDisplayName;
    return { kind: 'dm', label: handle ? dmLabel(handle) : 'DM' };
  }
  if (kind === 'thread') return { kind: 'thread', label: `${channel} · thread` };
  return { kind: 'channel', label: channel };
}

// The outbound chip fields as they appear in an activity payload (from the
// tool run) or a ledger message record. Empty string = absent.
interface OutboundSurfaceFields {
  channel: string;
  channelDisplayName: string;
  channelKind: string;
  channelName: string;
  dmHandle: string;
  platform: string;
  threadTs: string;
}

function surfaceChipForOutbound(activity: ActivityRecord): SurfaceChip {
  // Activities are agent-level, so outbound rows derive their surface from
  // the tool payload itself instead of joining back to an inbox item.
  const payload = activity.payload ?? {};
  const str = (key: string): string => {
    const value = payload[key];
    return typeof value === 'string' ? value : '';
  };
  return outboundSurfaceChip({
    channel: str('channel'),
    // channelDisplayName + channelKind come from slackTargetSummary() (e.g.
    // runMessageReact). channelDisplayName for channels = raw name like "team";
    // for DMs = "DM with <handle>". Used when channelName is absent.
    channelDisplayName: str('channelDisplayName'),
    channelKind: str('channelKind'),
    channelName: str('channelName'),
    dmHandle: str('dmHandle'),
    platform: str('platform'),
    threadTs: str('threadTs'),
  });
}

// Sibling of surfaceChipForOutbound for ledger records: outbound message rows
// carry the same surface fields flat on the record, so the chip derives
// directly instead of round-tripping through a synthesized activity.
function surfaceChipForOutboundMessage(message: AgentMessageRecord): SurfaceChip {
  return outboundSurfaceChip({
    channel: message.channelId ?? '',
    channelDisplayName: message.channelDisplayName ?? '',
    channelKind: message.channelKind ?? '',
    channelName: message.channelName ?? '',
    dmHandle: message.dmHandle ?? '',
    platform: message.platform ?? '',
    threadTs: message.threadTs ?? '',
  });
}

function outboundSurfaceChip(fields: OutboundSurfaceFields): SurfaceChip {
  const {
    channel: payloadChannel,
    channelDisplayName: payloadChannelDisplayName,
    channelKind: payloadChannelKind,
    channelName: payloadChannelName,
    dmHandle: payloadDmHandle,
    platform,
    threadTs: payloadThreadTs,
  } = fields;

  if (platform === 'feishu') {
    const kind = payloadChannelKind || (payloadChannel.startsWith('oc_') ? 'group' : 'chat');
    if (kind === 'open_id') {
      return { kind: 'dm', label: payloadChannelDisplayName || 'Feishu owner' };
    }
    const base = kind === 'p2p' ? 'Feishu DM' : `Feishu ${kind}`;
    if (payloadThreadTs) return { kind: 'thread', label: `${base} · topic` };
    if (kind === 'p2p') return { kind: 'dm', label: base };
    return { kind: 'channel', label: base };
  }

  // Cross-surface send (or reminder item with no inbound context).
  if (payloadDmHandle) {
    // Slack DM sends carry both `dmHandle` and `channel` (the D-id). This early
    // return wins over the payloadChannel branch below, so attach the channel id
    // here too, else outbound DM chips render as plain text while channel chips
    // deep-link, the same asymmetry the channel fix below resolves.
    const label = dmLabel(payloadDmHandle);
    return payloadChannel ? { kind: 'dm', label, channelId: payloadChannel } : { kind: 'dm', label };
  }
  if (payloadChannel) {
    // Carry the real Slack channel/DM id so the chip deep-links to the Channels
    // tab, mirroring the inbound path (surfaceChipForSlack). Without this,
    // outbound rows rendered the surface as plain, unclickable text while the
    // matching inbound rows linked, an asymmetry on the same conversation.
    const target = { channelId: payloadChannel };
    // DM detection: explicit kind flag (slackTargetSummary) or Slack DM id prefix.
    const isDm =
      payloadChannelKind === 'dm' ||
      (payloadChannel.startsWith('D') && !payloadChannelName && !payloadChannelDisplayName);
    if (isDm) {
      // Handle resolution priority: dmHandle (explicit) > channelDisplayName
      // "DM with <handle>" (slackTargetSummary) > anonymous "DM" fallback.
      // payloadDmHandle is empty here (the early-return above consumed it).
      const rawHandle = payloadChannelDisplayName.replace(/^DM with /i, '');
      const handle = rawHandle && rawHandle !== payloadChannelDisplayName ? rawHandle : '';
      return { kind: 'dm', label: handle ? dmLabel(handle) : 'DM', ...target };
    }
    // Channel label: channelName (explicit) > channelDisplayName from
    // slackTargetSummary > raw id as last resort. slackChannelDisplayName()
    // already prefixes `#` (e.g. "#team"), so avoid double-prefixing.
    const channel = payloadChannelName
      ? `#${payloadChannelName}`
      : payloadChannelDisplayName
        ? payloadChannelDisplayName.startsWith('#')
          ? payloadChannelDisplayName
          : `#${payloadChannelDisplayName}`
        : payloadChannel;
    if (payloadThreadTs) return { kind: 'thread', label: channel, ...target };
    return { kind: 'channel', label: channel, ...target };
  }
  // Fallback for outbound from a reminder item with no payload channel info
  return { kind: 'reminder', label: 'Reminder' };
}

// --- subagent stream helpers --------------------------------------------------

function buildSubagentStreams(
  byRun: Map<string, ActivityRecord[]>,
  showHidden: boolean,
): SubagentStream[] {
  const streams: SubagentStream[] = [];
  for (const [subRunId, childActivities] of byRun.entries()) {
    const first = childActivities[0];
    const name =
      first && typeof first.payload?.['name'] === 'string' ? first.payload['name'] : undefined;
    const role =
      first && typeof first.payload?.['role'] === 'string' ? first.payload['role'] : undefined;
    // The model the parent delegated this subagent to. Stamped onto child
    // activity payloads from the subagent transcript (see claude-events.ts).
    // First non-empty wins so a single missing line can't blank the label.
    const model = childActivities
      .map((a) => (typeof a.payload?.['model'] === 'string' ? a.payload['model'] : undefined))
      .find((m): m is string => Boolean(m));
    const depth =
      first && typeof first.payload?.['depth'] === 'number' ? first.payload['depth'] : 1;
    const items = buildChildFeedItems(childActivities, showHidden);
    streams.push({
      subRunId,
      ...(name ? { name } : {}),
      ...(role ? { role } : {}),
      ...(model ? { model } : {}),
      depth,
      items,
    });
  }
  // Sort streams by earliest activity timestamp so concurrent fan-out renders
  // in spawn order rather than Map insertion order.
  streams.sort((a, b) => {
    const aTs = a.items[0]?.timestamp ?? '';
    const bTs = b.items[0]?.timestamp ?? '';
    return aTs.localeCompare(bTs);
  });
  return streams;
}

/**
 * Shorten a raw provider model id to a human label for the activity feed.
 * Claude ids (`claude-haiku-4-5-20251001`) collapse to the family name; other
 * providers (e.g. Codex `gpt-5-codex`) keep their id minus a trailing date
 * stamp. Returns undefined when no model is known so callers can omit it.
 */
export function shortenModelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes('fable')) return 'Fable';
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('opus')) return 'Opus';
  return model.replace(/-\d{8}$/, '');
}

/**
 * Compose the "delegated to which subagent" summary for the parent step row:
 * `<type> · <model>` per stream, de-duplicated so a fan-out of identical
 * subagents reads once. Returns undefined when neither type nor model is known.
 */
export function subagentDelegationLabel(streams: SubagentStream[]): string | undefined {
  const parts = streams
    .map((s) => [s.role, shortenModelLabel(s.model)].filter(Boolean).join(' · '))
    .filter(Boolean);
  const distinct = Array.from(new Set(parts));
  return distinct.length > 0 ? distinct.join(', ') : undefined;
}

/** Build a flat list of feed items from child activities (no further nesting). */
function buildChildFeedItems(
  activities: ActivityRecord[],
  showHidden: boolean,
): ActivityFeedItem[] {
  const items: ActivityFeedItem[] = [];
  const recentOutboundTexts: RecentOutboundText[] = [];
  for (const activity of activities) {
    if (activity.type === 'runtime.steer_failed') continue;

    // Outbound external effects → typed rows (same as main loop, via the
    // shared classifier).
    if (
      activity.type === 'tool.call.completed' ||
      activity.type === 'external.effect.completed'
    ) {
      const payload = activity.payload ?? {};
      const tool = typeof payload['tool'] === 'string' ? payload['tool'] : undefined;
      const effect = typeof payload['effect'] === 'string' ? payload['effect'] : undefined;
      const classified = classifyOutboundEffect({ effect, tool });
      if (classified?.kind === 'message') {
        const text = payload['text'];
        const permalink =
          typeof payload['permalink'] === 'string' && payload['permalink']
            ? payload['permalink']
            : undefined;
        items.push({
          kind: 'message-out',
          text: typeof text === 'string' ? text : '',
          ...(permalink ? { permalink } : {}),
          timestamp: activity.createdAt,
          surface: surfaceChipForOutbound(activity),
          isEdit: classified.isEdit,
        });
        rememberOutboundText(recentOutboundTexts, activity);
        continue;
      }
      if (classified?.kind === 'file') {
        const caption = typeof payload['caption'] === 'string' ? payload['caption'] : '';
        const permalink =
          typeof payload['permalink'] === 'string' ? payload['permalink'] : undefined;
        const files = outboundFilesFromPayload(payload['uploads']);
        items.push({
          kind: 'file-out',
          caption,
          files,
          ...(permalink ? { permalink } : {}),
          timestamp: activity.createdAt,
          surface: surfaceChipForOutbound(activity),
        });
        continue;
      }
      if (tool === 'anima.reminder.fire') continue;
      if (classified?.kind === 'reaction') {
        const action: 'added' | 'removed' = payload['action'] === 'removed' ? 'removed' : 'added';
        const emoji = typeof payload['name'] === 'string' ? payload['name'] : '';
        const noop = payload['noop'] === true;
        items.push({
          kind: 'reaction-out',
          action,
          emoji,
          noop,
          timestamp: activity.createdAt,
          surface: surfaceChipForOutbound(activity),
        });
        continue;
      }
    }

    if (isDuplicateAgentText(activity, recentOutboundTexts)) continue;

    if (
      activity.type === 'tool.call.started' ||
      activity.type === 'tool.call.completed' ||
      activity.type === 'external.effect.started'
    ) {
      const payload = activity.payload ?? {};
      const tool = String(payload['tool'] ?? '');
      if (activity.type === 'external.effect.started') continue;
      if (activity.type === 'tool.call.started' && tool.startsWith('anima.')) continue;
      const providerName = String(payload['providerToolName'] ?? '').toLowerCase();
      if (providerName === 'shell' || providerName === 'bash') {
        const cmd = String(payload['command'] ?? payload['target'] ?? '').trim();
        if (
          /^(\/\S*sh\s+-l?c\s+['"])?\s*anima\s+(message|file|reminder|follow|subscription|ask)\b/.test(
            cmd,
          )
        )
          continue;
      }
    }

    if (activity.type === 'runtime.event') {
      if (isRuntimeEventNoise(String(activity.payload?.['eventType'] ?? ''))) continue;
    } else if (!showHidden && HIDDEN_TYPES.has(activity.type)) {
      continue;
    }

    items.push({ kind: 'step', activity, timestamp: activity.createdAt });
  }
  items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return items;
}

function rememberOutboundText(bucket: RecentOutboundText[], activity: ActivityRecord): void {
  const text = normalizedActivityText(activity.payload?.['text']);
  if (!text) return;
  const timestampMs = Date.parse(activity.createdAt);
  if (!Number.isFinite(timestampMs)) return;
  bucket.push({ text, timestampMs });
  const cutoff = timestampMs - DUPLICATE_AGENT_TEXT_WINDOW_MS;
  while (bucket[0] && bucket[0].timestampMs < cutoff) bucket.shift();
}

function isDuplicateAgentText(
  activity: ActivityRecord,
  recentOutboundTexts: RecentOutboundText[],
): boolean {
  if (activity.type !== 'agent.text') return false;
  const text = normalizedActivityText(activity.payload?.['text']);
  if (!text) return false;
  const timestampMs = Date.parse(activity.createdAt);
  if (!Number.isFinite(timestampMs)) return false;
  return recentOutboundTexts.some(
    (candidate) =>
      candidate.text === text &&
      Math.abs(timestampMs - candidate.timestampMs) <= DUPLICATE_AGENT_TEXT_WINDOW_MS,
  );
}

function normalizedActivityText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}
