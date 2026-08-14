import type { ProviderUsageKind, ProviderUsageResponse, ProviderUsageRow } from '../../shared/provider-usage.js';
import { fetchClaudeUsage } from './providers/claude.js';
import { fetchCodexUsage } from './providers/codex.js';
import { fetchGrokUsage } from './providers/grok.js';
import { fetchKimiUsage } from './providers/kimi.js';
import { fetchOpenCodeUsage } from './providers/opencode.js';
import { usageError } from './result.js';

export interface ProviderUsageAdapter {
  label: string;
  provider: ProviderUsageKind;
  source: ProviderUsageRow['source'];
  fetch: () => Promise<Array<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>>>;
  /** Optional single-row path for GET /provider-usage/:provider. */
  fetchActive?: () => Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>>;
}

export interface ProviderUsageReadOptions {
  force?: boolean;
}

export interface ProviderUsageServiceOptions {
  cacheTtlMs?: number;
  failureTtlMs?: number;
  log?: (message: string) => void;
  now?: () => number;
  staleMaxAgeMs?: number;
}

interface LastGoodUsageRow {
  observedAtMs: number;
  row: ProviderUsageRow;
}

interface ProviderUsageCacheEntry {
  expiresAtMs: number;
  lastGood: Map<string, LastGoodUsageRow>;
  refreshedAtMs: number;
  valueRows: ProviderUsageRow[];
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_FAILURE_TTL_MS = 5_000;
const DEFAULT_STALE_MAX_AGE_MS = 5 * 60_000;
const STALE_ELIGIBLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class ProviderUsageService {
  private readonly adapters: ProviderUsageAdapter[];
  private readonly cache = new Map<string, ProviderUsageCacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly inFlight = new Map<string, Promise<ProviderUsageRow[]>>();
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly staleMaxAgeMs: number;

  constructor(
    adapters: ProviderUsageAdapter[] = defaultProviderUsageAdapters(),
    options: ProviderUsageServiceOptions = {},
  ) {
    this.adapters = adapters;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.staleMaxAgeMs = options.staleMaxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
  }

  async list(options: ProviderUsageReadOptions = {}): Promise<ProviderUsageResponse> {
    const providers = (await Promise.all(
      this.adapters.map((adapter) => this.fetchProvider(adapter, { force: options.force })),
    )).flat();
    return { providers };
  }

  async get(provider: ProviderUsageKind, options: ProviderUsageReadOptions = {}): Promise<ProviderUsageRow> {
    const adapter = this.adapters.find((candidate) => candidate.provider === provider);
    if (!adapter) {
      return {
        checkedAt: new Date().toISOString(),
        error: usageError('unknown', `Provider usage adapter not found for ${provider}`),
        extras: [],
        label: provider,
        provider,
        source: 'native',
        status: 'unavailable',
        windows: [],
      };
    }
    const rows = await this.fetchProvider(adapter, { activeOnly: true, force: options.force });
    const row = rows[0];
    if (row) return row;
    return {
      checkedAt: new Date().toISOString(),
      error: usageError('unknown', `Provider usage adapter returned no rows for ${provider}`),
      extras: [],
      label: adapter.label,
      provider,
      source: adapter.source,
      status: 'unavailable',
      windows: [],
    };
  }

  private async fetchProvider(
    adapter: ProviderUsageAdapter,
    options: { activeOnly?: boolean; force?: boolean } = {},
  ): Promise<ProviderUsageRow[]> {
    const mode = options.activeOnly && adapter.fetchActive ? 'active' : 'all';
    const key = `${adapter.provider}:${mode}`;
    const nowMs = this.now();
    const cached = this.cache.get(key);
    if (!options.force && cached && cached.expiresAtMs > nowMs) {
      this.log(
        `[provider-usage] provider=${adapter.provider} mode=${mode} cache=hit ageMs=${Math.max(0, nowMs - cached.refreshedAtMs)} staleRows=${cached.valueRows.filter((row) => row.stale).length}`,
      );
      return cached.valueRows;
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const startedAtMs = nowMs;
    const pending = this.fetchProviderFresh(adapter, options)
      .then((freshRows) => {
        const completedAtMs = this.now();
        const merged = mergeWithLastGood(
          freshRows,
          cached?.lastGood,
          completedAtMs,
          this.staleMaxAgeMs,
        );
        const hasFailure = freshRows.some((row) => row.status === 'unavailable');
        const entry: ProviderUsageCacheEntry = {
          expiresAtMs: completedAtMs + (hasFailure ? this.failureTtlMs : this.cacheTtlMs),
          lastGood: merged.lastGood,
          refreshedAtMs: completedAtMs,
          valueRows: merged.rows,
        };
        this.cache.set(key, entry);
        this.log(providerUsageOutcomeLog({
          adapter,
          durationMs: Math.max(0, completedAtMs - startedAtMs),
          freshRows,
          mode,
          staleRows: merged.rows.filter((row) => row.stale).length,
        }));
        return entry.valueRows;
      })
      .finally(() => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async fetchProviderFresh(
    adapter: ProviderUsageAdapter,
    options: { activeOnly?: boolean } = {},
  ): Promise<ProviderUsageRow[]> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const rows = options.activeOnly && adapter.fetchActive
        ? [await adapter.fetchActive()]
        : await adapter.fetch();
      return rows.map((row) => ({
        checkedAt,
        label: adapter.label,
        provider: adapter.provider,
        source: adapter.source,
        ...row,
      }));
    } catch (error) {
      return [{
        checkedAt,
        error: usageError('unknown', error instanceof Error ? error.message : 'Provider usage adapter failed'),
        extras: [],
        label: adapter.label,
        provider: adapter.provider,
        source: adapter.source,
        status: 'unavailable',
        windows: [],
      }];
    }
  }
}

function mergeWithLastGood(
  freshRows: ProviderUsageRow[],
  previous: Map<string, LastGoodUsageRow> | undefined,
  nowMs: number,
  staleMaxAgeMs: number,
): { lastGood: Map<string, LastGoodUsageRow>; rows: ProviderUsageRow[] } {
  const lastGood = new Map<string, LastGoodUsageRow>();
  const rows = freshRows.map((fresh) => {
    const key = usageRowIdentity(fresh);
    if (fresh.status === 'available') {
      const row = { ...fresh };
      delete row.stale;
      lastGood.set(key, { observedAtMs: nowMs, row });
      return row;
    }

    const fallback = previous?.get(key);
    if (
      fallback
      && staleEligible(fresh)
      && nowMs - fallback.observedAtMs <= staleMaxAgeMs
    ) {
      lastGood.set(key, fallback);
      const staleRow: ProviderUsageRow = { ...fallback.row, stale: true };
      if (fresh.accountId !== undefined) staleRow.accountId = fresh.accountId;
      if (fresh.active !== undefined) staleRow.active = fresh.active;
      return staleRow;
    }

    return fresh;
  });
  return { lastGood, rows };
}

function staleEligible(row: ProviderUsageRow): boolean {
  if (row.error?.type === 'network_error') return true;
  return row.error?.status !== undefined && STALE_ELIGIBLE_STATUSES.has(row.error.status);
}

function usageRowIdentity(row: ProviderUsageRow): string {
  return row.accountId ?? row.account ?? '__default__';
}

function providerUsageOutcomeLog(input: {
  adapter: ProviderUsageAdapter;
  durationMs: number;
  freshRows: ProviderUsageRow[];
  mode: string;
  staleRows: number;
}): string {
  const unavailable = input.freshRows.filter((row) => row.status === 'unavailable');
  const errorTypes = [...new Set(unavailable.flatMap((row) => row.error?.type ? [row.error.type] : []))];
  const statuses = [...new Set(unavailable.flatMap((row) => row.error?.status ? [row.error.status] : []))];
  const attempts = Math.max(1, ...unavailable.map((row) => row.error?.attempts ?? 1));
  const outcome = unavailable.length === 0
    ? 'available'
    : input.staleRows > 0 && input.staleRows === unavailable.length
      ? 'stale'
      : unavailable.length === input.freshRows.length
        ? 'unavailable'
        : 'partial';
  const parts = [
    '[provider-usage]',
    `provider=${input.adapter.provider}`,
    `mode=${input.mode}`,
    'cache=miss',
    `outcome=${outcome}`,
    `durationMs=${input.durationMs}`,
    `attempts=${attempts}`,
    `rows=${input.freshRows.length}`,
    `staleRows=${input.staleRows}`,
  ];
  if (errorTypes.length > 0) parts.push(`errorTypes=${errorTypes.join(',')}`);
  if (statuses.length > 0) parts.push(`statuses=${statuses.join(',')}`);
  return parts.join(' ');
}

export function defaultProviderUsageAdapters(): ProviderUsageAdapter[] {
  return [
    {
      // Native ~/.claude only — no multi-account fan-out or registry discovery.
      fetch: async () => [await fetchClaudeUsage()],
      label: 'Claude Code',
      provider: 'claude-code',
      source: 'private-api',
    },
    {
      fetch: async () => [await fetchCodexUsage()],
      label: 'Codex CLI',
      provider: 'codex-cli',
      source: 'private-api',
    },
    {
      fetch: async () => [await fetchKimiUsage()],
      label: 'Kimi CLI',
      provider: 'kimi-cli',
      source: 'native',
    },
    {
      fetch: async () => [await fetchGrokUsage()],
      label: 'Grok Build',
      provider: 'grok-cli',
      // Account credits come from grok.com gRPC-Web billing (same path as Raycast Agent Usage),
      // not from a Grok CLI subcommand.
      source: 'private-api',
    },
    {
      fetch: async () => [await fetchOpenCodeUsage()],
      label: 'OpenCode',
      provider: 'opencode-cli',
      source: 'native',
    },
  ];
}

export const defaultProviderUsageService = new ProviderUsageService(
  defaultProviderUsageAdapters(),
  { log: (message) => console.info(message) },
);
