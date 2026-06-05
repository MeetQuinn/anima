import type { Command } from 'commander';
import { z } from 'zod';

import type { AgentMessageDirection, AgentMessageRecord } from '../../shared/messages.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { resolveToolAgentId } from './tool-context.js';

const MessageHistorySchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  since: z.string().optional(),
});

type MessageHistoryInput = z.infer<typeof MessageHistorySchema>;

export function registerMessageHistoryCommands(program: Command): void {
  program
    .command('inbox')
    .description('Show recent messages and wakes received by this agent.')
    .option('--limit <n>', 'max entries to return (default: 20; hard cap: 500)')
    .option('--before <iso>', 'page older than this ISO timestamp')
    .option('--since <iso>', 'only include entries at or after this ISO timestamp')
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
    .action(async (_, command) => {
      const opts = MessageHistorySchema.parse(command.optsWithGlobals());
      await runMessageHistory('out', opts);
    });
}

async function runMessageHistory(direction: AgentMessageDirection, opts: MessageHistoryInput): Promise<void> {
  const agentId = resolveToolAgentId({});
  if (!agentId) throw new Error(`${direction === 'in' ? 'inbox' : 'outbox'} requires current agent context`);
  const page = await messageServiceForAgent(agentId).list({
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

function normalizeTimeWindow(opts: MessageHistoryInput): { before?: string; since?: string } {
  return {
    ...(opts.before ? { before: normalizeIsoCursor(opts.before, '--before') } : {}),
    ...(opts.since ? { since: normalizeIsoCursor(opts.since, '--since') } : {}),
  };
}

function normalizeIsoCursor(value: string, flag: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${flag} must be an ISO timestamp`);
  return date.toISOString();
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
