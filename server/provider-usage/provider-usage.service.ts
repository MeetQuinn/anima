import type { ProviderUsageKind, ProviderUsageResponse, ProviderUsageRow } from '../../shared/provider-usage.js';
import type { AgentConfig } from '../../shared/agent-config.js';
import type { ProviderAccountsConfig } from '../../shared/provider-accounts.js';
import { fetchClaudeUsage } from './providers/claude.js';
import { fetchCodexUsage } from './providers/codex.js';
import { fetchGrokUsage } from './providers/grok.js';
import { fetchKimiUsage } from './providers/kimi.js';
import { usageError } from './result.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import {
  discoverClaudeAccounts,
  effectiveClaudeAccountRegistry,
  selectedClaudeAccount,
} from '../provider-accounts/claude-account-config.js';

export interface ProviderUsageAdapter {
  label: string;
  provider: ProviderUsageKind;
  source: ProviderUsageRow['source'];
  fetch: () => Promise<Array<Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>>>;
}

export class ProviderUsageService {
  constructor(private readonly adapters: ProviderUsageAdapter[] = defaultProviderUsageAdapters()) {}

  async list(): Promise<ProviderUsageResponse> {
    const providers = (await Promise.all(this.adapters.map((adapter) => this.fetchProvider(adapter)))).flat();
    return { providers };
  }

  async get(provider: ProviderUsageKind): Promise<ProviderUsageRow> {
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
    const rows = await this.fetchProvider(adapter);
    // Single-provider reads keep their pre-multi-account meaning: the account
    // the platform currently runs on, when the adapter marks one.
    const row = rows.find((candidate) => candidate.active) ?? rows[0];
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

  private async fetchProvider(adapter: ProviderUsageAdapter): Promise<ProviderUsageRow[]> {
    const checkedAt = new Date().toISOString();
    try {
      return (await adapter.fetch()).map((row) => ({
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

export function defaultProviderUsageAdapters(): ProviderUsageAdapter[] {
  return [
    {
      fetch: fetchAllClaudeAccountUsages,
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
  ];
}

// Usage is per account, not per active account: the panel shows every
// configured account's quota side by side, with switching left as a separate,
// deliberate act (totoday, 2026-07-18). Discovered accounts are included so the
// blocks match what the accounts API offers as switchable.
async function fetchAllClaudeAccountUsages(): ReturnType<ProviderUsageAdapter['fetch']> {
  const [providerAccounts, agents, discovered] = await Promise.all([
    defaultServerSettingsService.getProviderAccounts(),
    defaultAgentRegistryService.listAgentConfigs(),
    discoverClaudeAccounts(),
  ]);
  const registry = effectiveClaudeAccountRegistry(providerAccounts.claudeCode, agents, discovered);
  const selected = selectedClaudeAccount(registry);
  return Promise.all(registry.accounts.map(async (account) => ({
    accountId: account.id,
    active: account.id === selected.id,
    ...(await fetchClaudeUsage({ configDir: account.configDir })),
  })));
}

export function selectedClaudeUsageConfigDir(
  providerAccounts: ProviderAccountsConfig,
  agents: AgentConfig[],
): string | undefined {
  const registry = effectiveClaudeAccountRegistry(providerAccounts.claudeCode, agents);
  return selectedClaudeAccount(registry).configDir;
}

export const defaultProviderUsageService = new ProviderUsageService();
