import type { Command } from 'commander';
import { z } from 'zod';

import type { AgentMessageDirection, AgentMessageRecord } from '../../shared/messages.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { resolveToolAgentId } from './tool-context.js';

const MessageHistorySchema = z.object({
  before: z.string().optional(),
  channel: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  since: z.string().optional(),
});

type MessageHistoryInput = z.infer<typeof MessageHistorySchema>;

export interface MessageSearchCliInput {
  before?: string;
  channel?: string;
  keywords: string[];
  limit?: number;
  since?: string;
}

export function registerMessageHistoryCommands(program: Command): void {
  program
    .command('history')
    .description('Show one chronological timeline of recent received and sent conversation traffic.')
    .option('--limit <n>', 'max entries to return (default: 20; hard cap: 500)')
    .option('--before <iso>', 'page older than this ISO timestamp')
    .option('--since <iso>', 'only include entries at or after this ISO timestamp')
    .option('--channel <id-or-name>', 'only include entries from a channel, DM handle, or conversation id')
    .action(async (_, command) => {
      const opts = MessageHistorySchema.parse(command.optsWithGlobals());
      await runMessageTimeline(opts);
    });

  program
    .command('inbox')
    .description('Show recent messages and wakes received by this agent.')
    .option('--limit <n>', 'max entries to return (default: 20; hard cap: 500)')
    .option('--before <iso>', 'page older than this ISO timestamp')
    .option('--since <iso>', 'only include entries at or after this ISO timestamp')
    .option('--channel <id-or-name>', 'only include entries from a channel, DM handle, or conversation id')
    .action(async (_, command) => {
      const opts = MessageHistorySchema.parse(command.optsWithGlobals());
      await runMessageHistory('in', opts);
    });

  program
    .command('outbox')
    .description('Show recent messages, files, and reactions sent by this agent.')
    .option('--limit <n>', 'max entries to return (default: 20; hard cap: 500)')
    .option('--before <iso>', 'page older than this ISO timestamp')
    .option('--since <iso>', 'only include entries at or after this ISO timestamp')
    .option('--channel <id-or-name>', 'only include entries from a channel, DM handle, or conversation id')
    .action(async (_, command) => {
      const opts = MessageHistorySchema.parse(command.optsWithGlobals());
      await runMessageHistory('out', opts);
    });
}

async function runMessageTimeline(opts: MessageHistoryInput): Promise<void> {
  const agentId = resolveToolAgentId({});
  if (!agentId) throw new Error('history requires current agent context');
  const page = await messageServiceForAgent(agentId).list({
    channel: opts.channel,
    ...normalizeTimeWindow(opts),
    limit: opts.limit ?? 20,
  });
  if (page.entries.length === 0) {
    console.log('History is empty.');
    return;
  }
  const entries = [...page.entries].reverse();
  console.log(`History (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, newest last)`);
  for (const entry of entries) console.log(formatTimelineEntry(entry));
  console.log(`[page has_more=${Boolean(page.nextCursor)} next_cursor=${page.nextCursor ?? '-'}]`);
}

async function runMessageHistory(direction: AgentMessageDirection, opts: MessageHistoryInput): Promise<void> {
  const agentId = resolveToolAgentId({});
  if (!agentId) throw new Error(`${direction === 'in' ? 'inbox' : 'outbox'} requires current agent context`);
  const page = await messageServiceForAgent(agentId).list({
    channel: opts.channel,
    direction,
    ...normalizeTimeWindow(opts),
    limit: opts.limit ?? 20,
  });
  const title = direction === 'in' ? 'Inbox' : 'Outbox';
  if (page.entries.length === 0) {
    console.log(`${title} is empty.`);
    return;
  }
  console.log(`${title} (${page.entries.length} entr${page.entries.length === 1 ? 'y' : 'ies'}, newest first)`);
  for (const entry of page.entries) console.log(formatHistoryEntry(entry));
  console.log(`[page has_more=${Boolean(page.nextCursor)} next_cursor=${page.nextCursor ?? '-'}]`);
}

export async function runMessageSearch(opts: MessageSearchCliInput): Promise<void> {
  const agentId = resolveToolAgentId({});
  if (!agentId) throw new Error('message search requires current agent context');
  const keywords = normalizeSearchKeywords(opts.keywords);
  if (keywords.length === 0) throw new Error('message search requires at least one keyword');
  const page = await messageServiceForAgent(agentId).search({
    channel: opts.channel,
    keywords,
    ...normalizeTimeWindow(opts),
    limit: opts.limit ?? 20,
  });
  if (page.entries.length === 0) {
    console.log('Message search found no matches in this agent-visible history.');
    return;
  }
  console.log(`Message search (${page.entries.length} match${page.entries.length === 1 ? '' : 'es'}, newest first)`);
  for (const entry of page.entries) console.log(formatSearchEntry(entry, keywords));
  console.log(`[page has_more=${Boolean(page.nextCursor)} next_cursor=${page.nextCursor ?? '-'}]`);
}

function normalizeTimeWindow(opts: MessageHistoryInput): { before?: string; since?: string } {
  return {
    ...(opts.before ? { before: normalizeIsoCursor(opts.before, '--before') } : {}),
    ...(opts.since ? { since: normalizeIsoCursor(opts.since, '--since') } : {}),
  };
}

function normalizeSearchKeywords(keywords: string[]): string[] {
  return keywords
    .flatMap((keyword) => keyword.split(/\s+/g))
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function normalizeIsoCursor(value: string, flag: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${flag} must be an ISO timestamp`);
  return date.toISOString();
}

function formatSearchEntry(entry: AgentMessageRecord, keywords: string[]): string {
  const attrs = [`time=${entry.timestamp}`, `direction=${entry.direction}`];
  const surface = surfaceLabel(entry);
  if (surface) attrs.push(`channel=${surface}`);
  if (entry.channelId && entry.channelId !== surface) attrs.push(`channel_id=${entry.channelId}`);
  if (entry.threadTs) attrs.push(`thread_ts=${entry.threadTs}`);
  if (entry.messageTs) attrs.push(`message_ts=${entry.messageTs}`);
  const lead = entry.direction === 'in' ? `${entry.actor ?? 'Unknown'}:` : `${outboxVerb(entry)}:`;
  return `[${attrs.join(' ')}] ${lead} ${snippet(entry.text, keywords)}`;
}

function formatTimelineEntry(entry: AgentMessageRecord): string {
  const attrs = [`time=${entry.timestamp}`, `direction=${entry.direction}`];
  const surface = surfaceLabel(entry);
  if (surface) attrs.push(`channel=${surface}`);
  if (entry.channelId && entry.channelId !== surface) attrs.push(`channel_id=${entry.channelId}`);
  if (entry.threadTs) attrs.push(`thread_ts=${entry.threadTs}`);
  if (entry.messageTs) attrs.push(`message_ts=${entry.messageTs}`);
  const marker = entry.direction === 'in' ? 'IN' : 'OUT';
  const lead = entry.direction === 'in' ? `${entry.actor ?? 'Unknown'}:` : `${outboxVerb(entry)}:`;
  return `[${attrs.join(' ')}] ${marker} ${lead} ${oneLineText(entry.text)}`;
}

function formatHistoryEntry(entry: AgentMessageRecord): string {
  const attrs = [`time=${entry.timestamp}`];
  const surface = surfaceLabel(entry);
  if (surface) attrs.push(`channel=${surface}`);
  if (entry.channelId && entry.channelId !== surface) attrs.push(`channel_id=${entry.channelId}`);
  if (entry.threadTs) attrs.push(`thread_ts=${entry.threadTs}`);
  if (entry.messageTs) attrs.push(`message_ts=${entry.messageTs}`);
  const lead = entry.direction === 'in' ? `${entry.actor ?? 'Unknown'}:` : `${outboxVerb(entry)}:`;
  return `[${attrs.join(' ')}] ${lead} ${oneLineText(entry.text)}`;
}

function snippet(text: string, keywords: string[]): string {
  const normalized = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= 240) return normalized;
  const lower = normalized.toLowerCase();
  const firstMatch = keywords
    .map((keyword) => lower.indexOf(keyword.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(firstMatch - 80, normalized.length - 240));
  const end = Math.min(normalized.length, start + 240);
  return `${start > 0 ? '...' : ''}${normalized.slice(start, end)}${end < normalized.length ? '...' : ''}`;
}

function outboxVerb(entry: AgentMessageRecord): string {
  if (entry.kind === 'file') return 'sent file';
  if (entry.kind === 'reaction') {
    const reaction = entry.reaction;
    if (!reaction) return 'reacted';
    return `${reaction.action === 'removed' ? 'removed reaction' : 'reacted'} :${reaction.name}:`;
  }
  if (entry.kind === 'message' && entry.threadTs) return 'replied';
  return 'sent';
}

function surfaceLabel(entry: AgentMessageRecord): string | undefined {
  if (entry.dmHandle) return `@${entry.dmHandle.replace(/^@/, '')}`;
  if (entry.channelKind === 'dm') {
    const raw = entry.channelDisplayName?.replace(/^DM with /i, '');
    if (raw && raw !== entry.channelDisplayName) return raw.startsWith('@') ? raw : `@${raw}`;
    return entry.dmUserId ?? 'DM';
  }
  if (entry.channelName) return `#${entry.channelName.replace(/^#/, '')}`;
  if (entry.channelDisplayName) return entry.channelDisplayName.startsWith('#')
    ? entry.channelDisplayName
    : `#${entry.channelDisplayName.replace(/^#/, '')}`;
  return entry.channelId;
}

function oneLineText(text: string): string {
  const normalized = text.replace(/\r?\n/g, '\\n').trim();
  if (normalized.length <= 1000) return normalized;
  return `${normalized.slice(0, 997)}...`;
}
