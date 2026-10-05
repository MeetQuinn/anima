import { join } from 'node:path';

import { agentsDir } from './agent.store.js';
import type {
  AgentMessageAfterPage, AgentMessageDirection, AgentMessageHistoryPage, AgentMessageRecord,
} from '../../../shared/messages.js';
import { messageMatchesChannel } from '../../../shared/channel-match.js';
import { DEFAULT_JSONL_ROTATE_BYTES, JsonlAppendLog, type PositionedRecord } from '../jsonl-log.js';
import {
  encodeHistoryCursor, resolveHistoryAfter, resolveHistoryQuery, type HistoryFilters,
} from '../history-cursor.js';

type KeywordMatcher = (entry: AgentMessageRecord, keywords: string[]) => boolean;

const MESSAGE_DEDUPE_RECENT_LIMIT = 10_000;

export class MessageStore {
  constructor(private readonly agentId: string) {}

  async appendIfAbsent(record: AgentMessageRecord): Promise<{ inserted: boolean; record: AgentMessageRecord }> {
    const result = await this.log().appendIfRecent(
      record,
      (records) => !records.some((existing) => existing.messageId === record.messageId),
      MESSAGE_DEDUPE_RECENT_LIMIT,
    );
    return { inserted: result.appended, record };
  }

  async appendManyIfAbsent(records: AgentMessageRecord[]): Promise<{ inserted: number }> {
    const result = await this.log().appendManyByKey(records, (record) => record.messageId);
    return { inserted: result.appended };
  }

  async readAll(): Promise<AgentMessageRecord[]> {
    return this.log().readAll();
  }

  async hasMessageId(messageId: string): Promise<boolean> {
    return (await this.log().readNewestMatching(1, (entry) => entry.messageId === messageId)).length > 0;
  }

  async readPage(input: {
    before?: string;
    cursor?: string;
    channel?: string;
    direction?: AgentMessageDirection;
    keywords?: string[];
    limit: number;
    since?: string;
    threadTs?: string;
    matchesKeywords: KeywordMatcher;
  }): Promise<AgentMessageHistoryPage> {
    const { anchor, filters } = resolveHistoryQuery({
      agentId: this.agentId, kind: 'messages', before: input.before, cursor: input.cursor,
      filters: { channel: input.channel, direction: input.direction, keywords: input.keywords,
        since: input.since, threadTs: input.threadTs },
    });
    const { rows, hasMore } = await this.log().readPage({
      limit: input.limit, anchor, idOf: (entry) => entry.messageId,
      matches: messageMatcher(filters, input.matchesKeywords),
    });
    const last = rows.at(-1);
    const head = rows[0];
    return {
      entries: rows.map(({ record }) => record),
      nextCursor: hasMore && last ? this.cursorAt(filters, last) : null,
      // Rows come newest first, so the first page's first row is the head.
      ...(anchor ? {} : { headCursor: head ? this.cursorAt(filters, head) : null }),
    };
  }

  /** Entries appended after `after`, oldest first, in the cursor's scope. */
  async readAfter(input: {
    after: string;
    before?: string;
    cursor?: string;
    channel?: string;
    direction?: AgentMessageDirection;
    keywords?: string[];
    limit: number;
    since?: string;
    threadTs?: string;
    matchesKeywords: KeywordMatcher;
  }): Promise<AgentMessageAfterPage> {
    const { anchor, filters } = resolveHistoryAfter({
      agentId: this.agentId, kind: 'messages', after: input.after, before: input.before, cursor: input.cursor,
      filters: { channel: input.channel, direction: input.direction, keywords: input.keywords,
        since: input.since, threadTs: input.threadTs },
    });
    const { rows, hasMore } = await this.log().readPage({
      direction: 'newer', limit: input.limit, anchor, idOf: (entry) => entry.messageId,
      matches: messageMatcher(filters, input.matchesKeywords),
    });
    const last = rows.at(-1);
    return {
      readAfter: true,
      entries: rows.map(({ record }) => record),
      afterCursor: last ? this.cursorAt(filters, last) : null,
      hasMore,
    };
  }

  private cursorAt(filters: HistoryFilters, row: PositionedRecord<AgentMessageRecord>): string {
    return encodeHistoryCursor({ k: 'messages', a: this.agentId, f: filters, p: row.position, id: row.record.messageId });
  }

  async readLatest(input: {
    before?: string;
    channel?: string;
    direction?: AgentMessageDirection;
    limit: number;
    matches?: (entry: AgentMessageRecord) => boolean;
    since?: string;
    threadTs?: string;
  }): Promise<AgentMessageRecord[]> {
    return this.log().readNewestMatching(input.limit, (entry) =>
      (!input.direction || entry.direction === input.direction) &&
      (!input.before || entry.timestamp < input.before) &&
      (!input.since || entry.timestamp >= input.since) &&
      (!input.channel || messageMatchesChannel(entry, input.channel)) &&
      (!input.threadTs || (entry.threadTs ?? entry.messageTs) === input.threadTs) &&
      (!input.matches || input.matches(entry))
    );
  }

  private log(): JsonlAppendLog<AgentMessageRecord> {
    const root = join(agentsDir(), this.agentId);
    return new JsonlAppendLog<AgentMessageRecord>(join(root, 'messages.jsonl'), {
      archiveDir: join(root, 'messages.archive'),
      maxBytes: DEFAULT_JSONL_ROTATE_BYTES,
    });
  }
}

function messageMatcher(filters: HistoryFilters, matchesKeywords: KeywordMatcher): (entry: AgentMessageRecord) => boolean {
  return (entry) =>
    (!filters.direction || entry.direction === filters.direction) &&
    (!filters.beforeTime || entry.timestamp < filters.beforeTime) &&
    (!filters.since || entry.timestamp >= filters.since) &&
    (!filters.channel || messageMatchesChannel(entry, filters.channel)) &&
    (!filters.threadTs || (entry.threadTs ?? entry.messageTs) === filters.threadTs) &&
    (!filters.keywords || matchesKeywords(entry, filters.keywords));
}
