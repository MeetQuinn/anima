// Exact provider usage ledger for one agent. SQLite gives us a durable UNIQUE
// event id and range scans without loading/re-writing an ever-growing JSON file.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AGENT_ID, agentsDir } from './agent.store.js';
import { currentWriteRoot, ensureParentDirectory } from '../write-root.js';

export type StoredProviderUsageStatus = 'reported' | 'unavailable';

export interface StoredProviderUsage {
  eventId: string;
  occurredAt: string;
  itemId: string;
  runtimeKind: string;
  model?: string;
  accountId?: string;
  status: StoredProviderUsageStatus;
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

interface StoredCoverage {
  coverageStartedAt?: string;
}

interface SqliteUsageRow {
  event_id: string;
  occurred_at: string;
  item_id: string;
  runtime_kind: string;
  model: string | null;
  account_id: string | null;
  status: StoredProviderUsageStatus;
  input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
}

export class AgentTokenUsageStore {
  private readonly path: string;
  private readonly writeRoot: string;

  constructor(agentId: string) {
    if (!AGENT_ID.test(agentId)) throw new Error(`Invalid agent id: ${agentId}`);
    this.path = join(agentsDir(), agentId, 'token-usage.sqlite');
    this.writeRoot = currentWriteRoot();
  }

  async initialize(coverageStartedAt: string): Promise<StoredCoverage> {
    return this.withDatabase((db) => {
      db.prepare('INSERT OR IGNORE INTO usage_meta (key, value) VALUES (?, ?)')
        .run('coverage_started_at', coverageStartedAt);
      return this.readCoverageFrom(db);
    });
  }

  async insert(record: StoredProviderUsage): Promise<{ inserted: boolean }> {
    return this.withDatabase((db) => {
      const result = db.prepare(`
        INSERT INTO provider_usage (
          event_id, occurred_at, item_id, runtime_kind, model, account_id, status,
          input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          output_tokens, reasoning_output_tokens, total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          occurred_at = excluded.occurred_at,
          model = COALESCE(excluded.model, provider_usage.model),
          account_id = COALESCE(excluded.account_id, provider_usage.account_id),
          status = excluded.status,
          input_tokens = excluded.input_tokens,
          cache_read_input_tokens = excluded.cache_read_input_tokens,
          cache_creation_input_tokens = excluded.cache_creation_input_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          total_tokens = excluded.total_tokens
        WHERE provider_usage.status = 'unavailable' AND excluded.status = 'reported'
      `).run(
        record.eventId,
        record.occurredAt,
        record.itemId,
        record.runtimeKind,
        record.model ?? null,
        record.accountId ?? null,
        record.status,
        record.inputTokens ?? null,
        record.cacheReadInputTokens ?? null,
        record.cacheCreationInputTokens ?? null,
        record.outputTokens ?? null,
        record.reasoningOutputTokens ?? null,
        record.totalTokens ?? null,
      );
      return { inserted: result.changes > 0 };
    });
  }

  async listBetween(fromUtc: string, throughUtc: string): Promise<{
    coverageStartedAt?: string;
    records: StoredProviderUsage[];
  }> {
    if (!(await pathExists(this.path))) return { records: [] };
    return this.withDatabase((db) => ({
      ...this.readCoverageFrom(db),
      records: (db.prepare(`
        SELECT event_id, occurred_at, item_id, runtime_kind, model, account_id, status,
          input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          output_tokens, reasoning_output_tokens, total_tokens
        FROM provider_usage
        WHERE occurred_at >= ? AND occurred_at <= ?
        ORDER BY occurred_at ASC, event_id ASC
      `).all(fromUtc, throughUtc) as unknown as SqliteUsageRow[]).map(fromSqliteRow),
    }));
  }

  private async withDatabase<T>(op: (db: DatabaseSync) => T): Promise<T> {
    await ensureParentDirectory(this.path, this.writeRoot);
    const db = new DatabaseSync(this.path);
    try {
      // Connections are deliberately short-lived. The default rollback journal
      // avoids persistent -wal/-shm sidecars racing temp-home teardown while
      // SQLite still serializes the brief insert/range-read transactions.
      db.exec('PRAGMA journal_mode = DELETE;');
      db.exec('PRAGMA synchronous = FULL;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_usage (
          event_id TEXT PRIMARY KEY,
          occurred_at TEXT NOT NULL,
          item_id TEXT NOT NULL,
          runtime_kind TEXT NOT NULL,
          model TEXT,
          account_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('reported', 'unavailable')),
          input_tokens INTEGER,
          cache_read_input_tokens INTEGER,
          cache_creation_input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_output_tokens INTEGER,
          total_tokens INTEGER
        );
        CREATE INDEX IF NOT EXISTS provider_usage_occurred_at
          ON provider_usage (occurred_at);
      `);
      return op(db);
    } finally {
      db.close();
    }
  }

  private readCoverageFrom(db: DatabaseSync): StoredCoverage {
    const row = db.prepare("SELECT value FROM usage_meta WHERE key = 'coverage_started_at'")
      .get() as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? { coverageStartedAt: row.value } : {};
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code !== 'ENOENT') throw error;
    return false;
  }
}

function fromSqliteRow(row: SqliteUsageRow): StoredProviderUsage {
  return {
    accountId: row.account_id ?? undefined,
    cacheCreationInputTokens: row.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens: row.cache_read_input_tokens ?? undefined,
    eventId: row.event_id,
    inputTokens: row.input_tokens ?? undefined,
    itemId: row.item_id,
    model: row.model ?? undefined,
    occurredAt: row.occurred_at,
    outputTokens: row.output_tokens ?? undefined,
    reasoningOutputTokens: row.reasoning_output_tokens ?? undefined,
    runtimeKind: row.runtime_kind,
    status: row.status,
    totalTokens: row.total_tokens ?? undefined,
  };
}
