// Build a flat chronological activity feed for a single agent.
// No channel/thread clustering — users routinely jump between channel
// top-level and threads in the same conversation, so grouping fragments the
// natural reading flow. Each row carries its own Slack place chip; the visual
// rhythm comes from typography + day separators.

import type { Activity as ActivityRecord, AgentActivityFeedPage } from '@shared/activity';
import type { ChoiceResponseInboxItem, FeishuInboxItem, InboxItem, SlackInboxItem } from '@shared/inbox';
import type { AgentMessageHistoryPage, AgentMessageRecord } from '@shared/messages';

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
//     message_stop` case, iris #49 round-2 scope). hiddenRuntimeEvent() below.
//   Default-hidden, visible in show-all: meaningful lifecycle plumbing —
//     HIDDEN_TYPES (runtime.started/output/followup/pending/legacy steer) +
//     session stats / compact / rate-limit / model-routing events. These
//     surface when showHidden=true so the user can trace execution.
function hiddenRuntimeEvent(eventType: string): boolean {
  if (eventType === 'provider.reasoning') return true;
  if (eventType.endsWith('.context.stats')) return true;
  if (eventType.endsWith('.system.init')) return true;
  if (eventType.includes('.stream.')) return true;
  if (eventType.includes('.reasoning.')) return true;
  if (eventType.endsWith('.thinking.delta')) return true;
  if (eventType.endsWith('.content.part')) return true;
  if (eventType.endsWith('.tool.call.part')) return true;
  if (eventType.endsWith('.tool_result')) return true;
  if (eventType.endsWith('.hook.triggered') || eventType.endsWith('.hook.resolved')) return true;
  if (eventType.endsWith('.plan.display') || eventType.endsWith('.plan.updated')) return true;
  if (eventType.endsWith('.diff.updated')) return true;
  if (eventType.endsWith('.subagent.event')) return true;
  if (eventType.endsWith('.mcp.progress')) return true;
  if (eventType.endsWith('.raw_response_item.completed')) return true;
  if (eventType.endsWith('.steer.consumed')) return true;
  if (eventType.endsWith('.turn.started') || eventType.endsWith('.turn.completed')) return true;
  if (eventType.endsWith('.step.started')) return true;
  if (eventType.includes('.outputDelta')) return true;
  if (eventType.includes('.patchUpdated')) return true;
  return false;
}

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

// Metadata attached to a reminder-triggered message-in. Populated only when
// the item carries an `anima.reminder.fire` activity (Milo `ccbcc82`).
// Lets MessageInRow render `Reminder · fire #3` for recurring reminders
// without re-walking activities at render time.
export interface ReminderWakeMeta {
  firedCount: number;
  scheduleKind: string; // 'once' | recurring kind ('every'/'cron'/etc.)
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
      event: InboxItem;
      timestamp: string;
      surface: SurfaceChip;
      followupAppended: boolean;
      wakeMeta?: ReminderWakeMeta;
      // Inbound sender's Slack avatar (image_72), resolved best-effort by the
      // /messages route. Absent → the author resolver falls back to an initial.
      avatarUrl?: string;
    }
  | {
      kind: 'message-out';
      activity: ActivityRecord;
      text: string;
      timestamp: string;
      surface: SurfaceChip;
      isEdit: boolean;
    }
  | {
      kind: 'file-out';
      activity: ActivityRecord;
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
      activity: ActivityRecord;
      action: 'added' | 'removed';
      emoji: string;
      noop: boolean;
      timestamp: string;
      surface: SurfaceChip;
    }
  | { kind: 'step'; activity: ActivityRecord; timestamp: string; subagentStreams?: SubagentStream[] };

export function buildActivityFeed(
  activityFeed: AgentActivityFeedPage,
  showHidden = false,
): ActivityFeedItem[] {
  const activities = activityFeed.events.flatMap((event) =>
    event.kind === 'activity' ? [event.activity] : [],
  );
  const inboxItems = activityFeed.events.flatMap((event) =>
    event.kind === 'inbox' ? [event.item] : [],
  );

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

  // Pre-scan `anima.reminder.fire` activities so recurring reminder inbound
  // rows can show `fire #N`. Activities are agent-owned, so join on the
  // reminder id carried in both records rather than on a hidden item id.
  const wakeMetaByReminder = new Map<string, ReminderWakeMeta>();
  for (const activity of activities) {
    if (activity.type !== 'tool.call.completed') continue;
    if (activity.payload?.['tool'] !== 'anima.reminder.fire') continue;
    const reminderId =
      typeof activity.payload['reminderId'] === 'string' ? activity.payload['reminderId'] : '';
    if (!reminderId) continue;
    const firedCount =
      typeof activity.payload['firedCount'] === 'number' ? activity.payload['firedCount'] : 1;
    const scheduleKind =
      typeof activity.payload['scheduleKind'] === 'string'
        ? activity.payload['scheduleKind']
        : 'once';
    wakeMetaByReminder.set(reminderId, { firedCount, scheduleKind });
  }

  const items: ActivityFeedItem[] = [];
  const recentOutboundTexts: RecentOutboundText[] = [];

  for (const event of inboxItems) {
    const reminderId = event.kind === 'reminder' ? reminderIdForEvent(event) : undefined;
    const wakeMeta = reminderId ? wakeMetaByReminder.get(reminderId) : undefined;
    items.push({
      kind: 'message-in',
      event,
      timestamp: eventTimestamp(event),
      surface: surfaceChipForEvent(event, wakeMeta),
      followupAppended: false,
      ...(wakeMeta ? { wakeMeta } : {}),
    });
  }

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

    // External message/file/reaction effects → outbound feed items.
    if (activity.type === 'tool.call.completed' || activity.type === 'external.effect.completed') {
      const tool = activity.payload?.['tool'];
      const effect = activity.payload?.['effect'];
      if (
        tool === 'anima.message.send' ||
        tool === 'anima.message.update' ||
        effect === 'slack.message.send' ||
        effect === 'slack.message.update' ||
        effect === 'feishu.message.send'
      ) {
        const text = activity.payload?.['text'];
        items.push({
          kind: 'message-out',
          activity,
          text: typeof text === 'string' ? text : '',
          timestamp: activity.createdAt,
          surface: surfaceChipForOutbound(activity),
          isEdit: tool === 'anima.message.update' || effect === 'slack.message.update',
        });
        rememberOutboundText(recentOutboundTexts, activity);
        continue;
      }
      if (tool === 'anima.file.send' || effect === 'slack.file.send') {
        const payload = activity.payload ?? {};
        const caption = typeof payload['caption'] === 'string' ? payload['caption'] : '';
        const permalink =
          typeof payload['permalink'] === 'string' ? payload['permalink'] : undefined;
        const files = outboundFilesFromPayload(payload['uploads']);
        items.push({
          kind: 'file-out',
          activity,
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
      if (tool === 'anima.message.react' || effect === 'slack.reaction') {
        const payload = activity.payload ?? {};
        const action: 'added' | 'removed' = payload['action'] === 'removed' ? 'removed' : 'added';
        const emoji = typeof payload['name'] === 'string' ? payload['name'] : '';
        const noop = payload['noop'] === true;
        items.push({
          kind: 'reaction-out',
          activity,
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
      if (hiddenRuntimeEvent(String(activity.payload?.['eventType'] ?? ''))) continue;
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

export function buildMessageFeed(messagePage: AgentMessageHistoryPage): ActivityFeedItem[] {
  const items: ActivityFeedItem[] = [];
  for (const message of messagePage.entries) {
    if (message.direction === 'in') {
      const event = inboxItemForMessage(message);
      items.push({
        kind: 'message-in',
        event,
        timestamp: message.timestamp,
        surface: surfaceChipForEvent(event),
        followupAppended: false,
        ...(message.actorAvatarUrl ? { avatarUrl: message.actorAvatarUrl } : {}),
      });
      continue;
    }
    if (message.kind === 'message') {
      const activity = activityForMessage(message);
      items.push({
        kind: 'message-out',
        activity,
        text: message.text,
        timestamp: message.timestamp,
        surface: surfaceChipForOutbound(activity),
        isEdit: message.isEdit === true,
      });
      continue;
    }
    if (message.kind === 'file') {
      const activity = activityForMessage(message);
      items.push({
        kind: 'file-out',
        activity,
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
        surface: surfaceChipForOutbound(activity),
      });
      continue;
    }
    if (message.kind === 'reaction') {
      const activity = activityForMessage(message);
      items.push({
        kind: 'reaction-out',
        activity,
        action: message.reaction?.action ?? 'added',
        emoji: message.reaction?.name ?? '',
        noop: message.reaction?.noop === true,
        timestamp: message.timestamp,
        surface: surfaceChipForOutbound(activity),
      });
    }
  }
  return items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function inboxItemForMessage(message: AgentMessageRecord): InboxItem {
  const handling = {
    completedAt: message.timestamp,
    createdAt: message.timestamp,
    status: 'completed' as const,
    updatedAt: message.timestamp,
  };
  const base = {
    handling,
    id: message.source.kind === 'inbox' ? message.source.id : message.messageId,
    receivedAt: message.timestamp,
  };
  if (message.kind === 'reminder') {
    return {
      ...base,
      kind: 'reminder',
      reminderId: message.reminderId ?? message.source.id,
      ...(message.reminderTitle ? { title: message.reminderTitle } : {}),
    };
  }
  if (message.kind === 'onboarding') {
    if (message.platform === 'feishu') {
      const ownerOpenId = message.actorUserId ?? '';
      return {
        ...base,
        kind: 'feishu_onboarding',
        owner: {
          openId: ownerOpenId,
        },
        target: {
          platform: 'feishu',
          receiveId: ownerOpenId,
          receiveIdType: 'open_id',
        },
        text: message.text,
      };
    }
    return {
      ...base,
      channelId: message.channelId ?? '',
      kind: 'onboarding',
      operator: {
        displayName: message.actorDisplayName ?? message.actor ?? 'Owner',
        ...(message.actorHandle ? { handle: message.actorHandle } : {}),
        slackUserId: message.actorUserId ?? '',
      },
      teamId: '',
      text: message.text,
    };
  }
  if (message.kind === 'choice_response') {
    return {
      ...base,
      answeredBy: {
        ...(message.actorDisplayName ? { displayName: message.actorDisplayName } : {}),
        ...(message.actorHandle ? { handle: message.actorHandle } : {}),
        slackUserId: message.actorUserId ?? '',
      },
      askId: message.source.id,
      channelId: message.channelId ?? '',
      ...(message.channelName ? { channelName: message.channelName } : {}),
      kind: 'choice_response',
      messageTs: message.messageTs ?? '',
      optionId: message.optionLabel ?? message.messageId,
      optionLabel: message.optionLabel ?? message.text,
      question: message.question ?? '',
      teamId: '',
      threadTs: message.threadTs ?? '',
    };
  }
  if (message.platform === 'feishu') {
    return {
      ...base,
      actor: {
        ...(message.actorDisplayName ? { displayName: message.actorDisplayName } : {}),
        ...(message.actorUserId ? { openId: message.actorUserId } : {}),
      },
      chatId: message.channelId ?? '',
      chatType: message.channelKind ?? 'group',
      ...(message.files?.length ? {
        files: message.files.map((file, index) => ({
          id: file.fileId ?? `${message.messageId}:file:${index}`,
          mimetype: file.mimetype ?? 'application/octet-stream',
          name: file.filename,
          sizeBytes: file.sizeBytes ?? 0,
        })),
      } : {}),
      kind: 'feishu',
      messageId: message.messageTs ?? message.messageId,
      text: message.text,
      ...(message.threadTs ? { threadId: message.threadTs } : {}),
    };
  }
  return {
    ...base,
    actor: {
      ...(message.actorDisplayName ? { displayName: message.actorDisplayName } : {}),
      ...(message.actorHandle ? { handle: message.actorHandle } : {}),
      ...(message.actorUserId ? { userId: message.actorUserId } : {}),
    },
    channelId: message.channelId ?? '',
    ...(message.channelName ? { channelName: message.channelName } : {}),
    ...(message.files?.length ? {
      files: message.files.map((file, index) => ({
        id: file.fileId ?? `${message.messageId}:file:${index}`,
        mimetype: file.mimetype ?? 'application/octet-stream',
        name: file.filename,
        sizeBytes: file.sizeBytes ?? 0,
      })),
    } : {}),
    kind: 'slack',
    messageTs: message.messageTs ?? '',
    ...(message.permalink ? { permalink: message.permalink } : {}),
    teamId: '',
    text: message.text,
    ...(message.threadTs ? { threadTs: message.threadTs } : {}),
  };
}

function activityForMessage(message: AgentMessageRecord): ActivityRecord {
  const payload: Record<string, unknown> = {
    channel: message.channelId,
    channelDisplayName: message.channelDisplayName,
    channelKind: message.channelKind,
    channelName: message.channelName,
    dmHandle: message.dmHandle,
    dmUserId: message.dmUserId,
    permalink: message.permalink,
    platform: message.platform,
    status: 'completed',
    text: message.text,
    threadTs: message.threadTs,
    ts: message.messageTs,
  };
  if (message.kind === 'message') {
    payload['effect'] = message.platform === 'feishu'
      ? 'feishu.message.send'
      : message.isEdit ? 'slack.message.update' : 'slack.message.send';
  } else if (message.kind === 'file') {
    payload['effect'] = 'slack.file.send';
    payload['caption'] = message.text.split(/\r?\nFiles:/)[0] ?? '';
    payload['uploads'] = (message.files ?? []).map((file, index) => ({
      fileId: file.fileId ?? `${message.messageId}:file:${index}`,
      filename: file.filename,
      mimetype: file.mimetype ?? 'application/octet-stream',
      permalink: file.permalink,
      sizeBytes: file.sizeBytes ?? 0,
      thumb360: file.thumb360,
      thumb720: file.thumb720,
    }));
  } else if (message.kind === 'reaction') {
    payload['effect'] = 'slack.reaction';
    payload['action'] = message.reaction?.action ?? 'added';
    payload['name'] = message.reaction?.name ?? '';
    payload['noop'] = message.reaction?.noop === true;
    payload['targetTs'] = message.messageTs;
  }
  return {
    activityId: message.source.kind === 'activity' ? message.source.id : message.messageId,
    createdAt: message.timestamp,
    payload,
    type: 'external.effect.completed',
  };
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

function surfaceChipForEvent(event: InboxItem, wakeMeta?: ReminderWakeMeta): SurfaceChip {
  if (isOnboardingWake(event)) return { kind: 'onboarding', label: 'Onboarding' };
  if (event.kind === 'reminder') {
    // Recurring reminders surface their occurrence count so a user can
    // tell "this is the 3rd time this daily reminder fired today" from the
    // chip alone. One-shot wakes without fire metadata
    // keep the plain `Reminder` label.
    const recurring = wakeMeta && wakeMeta.scheduleKind !== 'once';
    const label = recurring ? `Reminder · fire #${wakeMeta.firedCount}` : 'Reminder';
    return { kind: 'reminder', label };
  }
  if (event.kind === 'memory_coherence') return { kind: 'reminder', label: 'Memory coherence' };
  if (event.kind === 'choice_response') return surfaceChipForChoice(event);
  if (event.kind === 'feishu') return surfaceChipForFeishu(event);
  if (event.kind !== 'slack') return { kind: 'onboarding', label: 'Onboarding' };
  return surfaceChipForSlack(event);
}

export function isOnboardingWake(event: InboxItem): boolean {
  return event.kind === 'onboarding' || event.kind === 'feishu_onboarding' || event.id.startsWith('agent-onboarding:');
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

function surfaceChipForSlack(event: SlackInboxItem): SurfaceChip {
  const channelId = event.channelId ?? 'unknown-channel';
  const channelName = event.channelName;
  const threadTs = event.threadTs;
  const kind = channelId.startsWith('D') ? 'dm' : threadTs ? 'thread' : 'channel';
  // Fall back to the raw channel id rather than "Unknown channel" — the id is
  // real data and at least lets the user look it up; the string literal
  // was a debugging placeholder that leaked into the UI (round-2 item 3).
  const channel = channelName ? `#${channelName}` : channelId;
  // Carry the real channel id so the Activity timeline can link the chip to the
  // Channels tab. Omit the placeholder so an unknown surface stays non-clickable
  // rather than linking to nowhere (iris's honest-degrade bar).
  const target = event.channelId ? { channelId: event.channelId } : {};
  if (kind === 'dm') {
    const handle = event.actor?.handle || event.actor?.displayName;
    return { kind: 'dm', label: handle ? `@${handle.replace(/^@/, '')}` : 'DM', ...target };
  }
  if (kind === 'thread') return { kind: 'thread', label: `${channel} · thread`, ...target };
  return { kind: 'channel', label: channel, ...target };
}

function surfaceChipForFeishu(event: FeishuInboxItem): SurfaceChip {
  const label = event.chatType === 'p2p' ? 'Feishu DM' : `Feishu ${event.chatType || 'chat'}`;
  if (event.threadId) return { kind: 'thread', label: `${label} · topic` };
  if (event.chatType === 'p2p') return { kind: 'dm', label };
  return { kind: 'channel', label };
}

function surfaceChipForChoice(event: ChoiceResponseInboxItem): SurfaceChip {
  const channelId = event.channelId ?? 'unknown-channel';
  const channelName = event.channelName;
  const threadTs = event.threadTs;
  const kind = channelId.startsWith('D') ? 'dm' : threadTs ? 'thread' : 'channel';
  const channel = channelName
    ? channelName.startsWith('#') ? channelName : `#${channelName}`
    : channelId;
  if (kind === 'dm') {
    const handle = event.answeredBy.handle || event.answeredBy.displayName;
    return { kind: 'dm', label: handle ? `@${handle.replace(/^@/, '')}` : 'DM' };
  }
  if (kind === 'thread') return { kind: 'thread', label: `${channel} · thread` };
  return { kind: 'channel', label: channel };
}

function surfaceChipForOutbound(activity: ActivityRecord): SurfaceChip {
  // Activities are agent-level, so outbound rows derive their surface from
  // the tool payload itself instead of joining back to an inbox item.
  const payload = activity.payload ?? {};
  const payloadChannel = typeof payload['channel'] === 'string' ? payload['channel'] : '';
  const payloadChannelName =
    typeof payload['channelName'] === 'string' ? payload['channelName'] : '';
  // channelDisplayName + channelKind come from slackTargetSummary() (e.g.
  // runMessageReact). channelDisplayName for channels = raw name like "team";
  // for DMs = "DM with <handle>". Use them when channelName is absent.
  const payloadChannelDisplayName =
    typeof payload['channelDisplayName'] === 'string' ? payload['channelDisplayName'] : '';
  const payloadChannelKind =
    typeof payload['channelKind'] === 'string' ? payload['channelKind'] : '';
  const payloadDmHandle = typeof payload['dmHandle'] === 'string' ? payload['dmHandle'] : '';
  const payloadThreadTs = typeof payload['threadTs'] === 'string' ? payload['threadTs'] : '';
  const platform = typeof payload['platform'] === 'string' ? payload['platform'] : '';

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
  if (payloadDmHandle) return { kind: 'dm', label: `@${payloadDmHandle.replace(/^@/, '')}` };
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
      return { kind: 'dm', label: handle ? `@${handle.replace(/^@/, '')}` : 'DM', ...target };
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

function eventTimestamp(event: InboxItem): string {
  return event.receivedAt ?? new Date(0).toISOString();
}

function reminderIdForEvent(event: InboxItem): string | undefined {
  if (event.kind !== 'reminder') return undefined;
  return event.reminderId;
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

    // Outbound external effects → typed rows (same as main loop).
    if (
      activity.type === 'tool.call.completed' ||
      activity.type === 'external.effect.completed'
    ) {
      const tool = activity.payload?.['tool'];
      const effect = activity.payload?.['effect'];
      if (
        tool === 'anima.message.send' ||
        tool === 'anima.message.update' ||
        effect === 'slack.message.send' ||
        effect === 'slack.message.update' ||
        effect === 'feishu.message.send'
      ) {
        const text = activity.payload?.['text'];
        items.push({
          kind: 'message-out',
          activity,
          text: typeof text === 'string' ? text : '',
          timestamp: activity.createdAt,
          surface: surfaceChipForOutbound(activity),
          isEdit: tool === 'anima.message.update' || effect === 'slack.message.update',
        });
        rememberOutboundText(recentOutboundTexts, activity);
        continue;
      }
      if (tool === 'anima.file.send' || effect === 'slack.file.send') {
        const payload = activity.payload ?? {};
        const caption = typeof payload['caption'] === 'string' ? payload['caption'] : '';
        const permalink =
          typeof payload['permalink'] === 'string' ? payload['permalink'] : undefined;
        const files = outboundFilesFromPayload(payload['uploads']);
        items.push({
          kind: 'file-out',
          activity,
          caption,
          files,
          ...(permalink ? { permalink } : {}),
          timestamp: activity.createdAt,
          surface: surfaceChipForOutbound(activity),
        });
        continue;
      }
      if (tool === 'anima.reminder.fire') continue;
      if (tool === 'anima.message.react' || effect === 'slack.reaction') {
        const payload = activity.payload ?? {};
        const action: 'added' | 'removed' = payload['action'] === 'removed' ? 'removed' : 'added';
        const emoji = typeof payload['name'] === 'string' ? payload['name'] : '';
        const noop = payload['noop'] === true;
        items.push({
          kind: 'reaction-out',
          activity,
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
      if (hiddenRuntimeEvent(String(activity.payload?.['eventType'] ?? ''))) continue;
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
