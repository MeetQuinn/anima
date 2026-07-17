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
  effectiveClaudeAccountRegistry,
  selectedClaudeAccount,
} from '../provider-accounts/claude-account-config.js';

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
    return this.fetchProvider(adapter);
  }

  private async fetchProvider(adapter: ProviderUsageAdapter): Promise<ProviderUsageRow> {
    const checkedAt = new Date().toISOString();
    try {
      return {
        checkedAt,
        label: adapter.label,
        provider: adapter.provider,
        source: adapter.source,
        ...(await adapter.fetch()),
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
      fetch: fetchSelectedClaudeUsage,
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
    {
      fetch: fetchGrokUsage,
      label: 'Grok Build',
      provider: 'grok-cli',
      // Account credits come from grok.com gRPC-Web billing (same path as Raycast Agent Usage),
      // not from a Grok CLI subcommand.
      source: 'private-api',
    },
  ];
}

async function fetchSelectedClaudeUsage(): ReturnType<typeof fetchClaudeUsage> {
  const [providerAccounts, agents] = await Promise.all([
    defaultServerSettingsService.getProviderAccounts(),
    defaultAgentRegistryService.listAgentConfigs(),
  ]);
  return fetchClaudeUsage({ configDir: selectedClaudeUsageConfigDir(providerAccounts, agents) });
}

export function selectedClaudeUsageConfigDir(
  providerAccounts: ProviderAccountsConfig,
  agents: AgentConfig[],
): string | undefined {
  const registry = effectiveClaudeAccountRegistry(providerAccounts.claudeCode, agents);
  return selectedClaudeAccount(registry).configDir;
}

export const defaultProviderUsageService = new ProviderUsageService();
