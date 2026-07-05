import { join } from 'node:path';

import { agentsDir } from './agent.store.js';
import type { AgentMessageDirection, AgentMessageRecord } from '../../../shared/messages.js';
import { messageMatchesChannel } from '../../../shared/channel-match.js';
import { DEFAULT_JSONL_ROTATE_BYTES, JsonlAppendLog } from '../jsonl-log.js';

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

  async readLatest(input: {
    before?: string;
    channel?: string;
    direction?: AgentMessageDirection;
    limit: number;
    matches?: (entry: AgentMessageRecord) => boolean;
    since?: string;
  }): Promise<AgentMessageRecord[]> {
    return this.log().readNewestMatching(input.limit, (entry) =>
      (!input.direction || entry.direction === input.direction) &&
      (!input.before || entry.timestamp < input.before) &&
      (!input.since || entry.timestamp >= input.since) &&
      (!input.channel || messageMatchesChannel(entry, input.channel)) &&
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
