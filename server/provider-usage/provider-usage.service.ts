import type {
  ProviderUsageKind,
  ProviderUsageResponse,
  ProviderUsageRow,
} from '../../shared/provider-usage.js';
import { fetchClaudeUsage } from './providers/claude.js';
import { fetchCodexUsage } from './providers/codex.js';
import { fetchKimiUsage } from './providers/kimi.js';
import { usageError } from './result.js';

export interface ProviderUsageAdapter {
  label: string;
  provider: ProviderUsageKind;
  source: ProviderUsageRow['source'];
  fetch: () => Promise<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>>;
}

export class ProviderUsageService {
  constructor(private readonly adapters: ProviderUsageAdapter[] = defaultProviderUsageAdapters()) {}

  async list(): Promise<ProviderUsageResponse> {
    const providers = await Promise.all(this.adapters.map((adapter) => this.fetchProvider(adapter)));
    return { providers };
  }

  private async fetchProvider(adapter: ProviderUsageAdapter): Promise<ProviderUsageRow> {
    const checkedAt = new Date().toISOString();
    try {
      return {
        checkedAt,
        label: adapter.label,
        provider: adapter.provider,
        source: adapter.source,
        ...await adapter.fetch(),
      };
    } catch (error) {
      return {
        checkedAt,
        error: usageError('unknown', error instanceof Error ? error.message : 'Provider usage adapter failed'),
        extras: [],
        label: adapter.label,
        provider: adapter.provider,
        source: adapter.source,
        status: 'unavailable',
        windows: [],
      };
    }
  }
}

export function defaultProviderUsageAdapters(): ProviderUsageAdapter[] {
  return [
    {
      fetch: fetchClaudeUsage,
      label: 'Claude Code',
      provider: 'claude-code',
      source: 'private-api',
    },
    {
      fetch: fetchCodexUsage,
      label: 'Codex CLI',
      provider: 'codex-cli',
      source: 'private-api',
    },
    {
      fetch: fetchKimiUsage,
      label: 'Kimi CLI',
      provider: 'kimi-cli',
      source: 'native',
    },
  ];
}

export const defaultProviderUsageService = new ProviderUsageService();
