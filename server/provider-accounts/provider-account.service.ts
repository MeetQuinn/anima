import type { AgentConfig } from '../../shared/agent-config.js';
import type {
  ClaudeCodeAccountRegistry,
  ClaudeCodeAccountState,
  ProviderAccountsResponse,
} from '../../shared/provider-accounts.js';
import type { AgentStatusSummary } from '../../shared/snapshot.js';
import { isAgentRunnable } from '../agents/agent-config-ops.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { defaultRuntimeService } from '../runtime/runtime.service.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import {
  claudeAccountContinuityNeedsSetup,
  ClaudeAccountContinuityError,
  ensureClaudeAccountsContinuity,
} from './claude-account-continuity.js';
import { synchronizeClaudeAccountMcpState } from './claude-account-mcp.js';
import {
  applyClaudeAccountToAgent,
  claudeAccountIsConfigured,
  discoverClaudeAccounts,
  effectiveClaudeAccountRegistry,
  readClaudeAccountName,
  selectedClaudeAccount,
} from './claude-account-config.js';

export class ProviderAccountError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'ProviderAccountError';
  }
}

interface ProviderAccountSettings {
  getProviderAccounts(): ReturnType<typeof defaultServerSettingsService.getProviderAccounts>;
  setProviderAccounts(
    providerAccounts: Parameters<typeof defaultServerSettingsService.setProviderAccounts>[0],
  ): ReturnType<typeof defaultServerSettingsService.setProviderAccounts>;
}

interface ProviderAccountAgents {
  listAgentConfigs(): ReturnType<typeof defaultAgentRegistryService.listAgentConfigs>;
}

interface ProviderAccountRuntime {
  listStatuses(): ReturnType<typeof defaultRuntimeService.listStatuses>;
  reloadAgentWhenIdle(agentId: string): ReturnType<typeof defaultRuntimeService.reloadAgentWhenIdle>;
}

export class ProviderAccountService {
  private selectionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: ProviderAccountSettings = defaultServerSettingsService,
    private readonly agents: ProviderAccountAgents = defaultAgentRegistryService,
    private readonly runtime: ProviderAccountRuntime = defaultRuntimeService,
    private readonly ensureContinuity: typeof ensureClaudeAccountsContinuity = ensureClaudeAccountsContinuity,
    private readonly discoverAccounts: typeof discoverClaudeAccounts = discoverClaudeAccounts,
    private readonly continuityNeedsSetup: typeof claudeAccountContinuityNeedsSetup = claudeAccountContinuityNeedsSetup,
    private readonly synchronizeMcpState: typeof synchronizeClaudeAccountMcpState = synchronizeClaudeAccountMcpState,
  ) {}

  async list(): Promise<ProviderAccountsResponse> {
    return { providers: [await this.claudeState()] };
  }

  async claudeState(): Promise<ClaudeCodeAccountState> {
    const [configured, agents, statuses, discovered] = await Promise.all([
      this.settings.getProviderAccounts(),
      this.agents.listAgentConfigs(),
      this.runtime.listStatuses(),
      this.discoverAccounts(),
    ]);
    const registry = effectiveClaudeAccountRegistry(configured.claudeCode, agents, discovered);
    const selected = selectedClaudeAccount(registry);
    const accounts = await Promise.all(registry.accounts.map(async (account) => {
      const accountName = await readClaudeAccountName(account);
      return {
        ...(accountName ? { account: accountName } : {}),
        id: account.id,
        label: account.label,
        profile: account.configDir ? 'isolated' as const : 'default' as const,
        selected: account.id === selected.id,
        status: await claudeAccountIsConfigured(account) ? 'available' as const : 'not_configured' as const,
      };
    }));
    const switchState = accountSwitchState(registry, statuses);
    return {
      accounts,
      activeAccountId: selected.id,
      errorAgentIds: switchState.errorAgentIds,
      pendingAgentIds: switchState.pendingAgentIds,
      provider: 'claude-code',
      status: switchState.status,
    };
  }

  selectClaudeAccount(accountId: string): Promise<ClaudeCodeAccountState> {
    const selection = this.selectionTail.then(() => this.performClaudeAccountSelection(accountId));
    this.selectionTail = selection.then(() => undefined, () => undefined);
    return selection;
  }

  private async performClaudeAccountSelection(accountId: string): Promise<ClaudeCodeAccountState> {
    const [providerAccounts, agents, statuses, discovered] = await Promise.all([
      this.settings.getProviderAccounts(),
      this.agents.listAgentConfigs(),
      this.runtime.listStatuses(),
      this.discoverAccounts(),
    ]);
    const registry = effectiveClaudeAccountRegistry(providerAccounts.claudeCode, agents, discovered);
    const target = registry.accounts.find((account) => account.id === accountId);
    if (!target) throw new ProviderAccountError(404, `Claude account not found: ${accountId}`);
    if (!await claudeAccountIsConfigured(target)) {
      throw new ProviderAccountError(409, `Claude account ${target.label} is not authenticated`);
    }

    const currentSwitchState = accountSwitchState(registry, statuses);
    const retryAgentIds = registry.activeAccountId === target.id && currentSwitchState.status === 'error'
      ? currentSwitchState.errorAgentIds
      : undefined;
    if (providerAccounts.claudeCode && registry.activeAccountId === target.id && !retryAgentIds?.length) {
      return this.claudeState();
    }

    const affectedAgents = agents.filter((agent) => affectedClaudeAgent(agent));
    const current = selectedClaudeAccount(registry);
    const continuityAccounts = [current, target]
      .filter((account, index, values) => account.configDir && values.findIndex((value) => value.id === account.id) === index);
    const needsContinuitySetup = (await Promise.all(
      continuityAccounts.map((account) => this.continuityNeedsSetup(account)),
    )).some(Boolean);
    if (needsContinuitySetup) {
      const affectedAgentIds = new Set(affectedAgents.map((agent) => agent.id));
      const activeAgentIds = statuses
        .filter((status) => (status.currentItemId || status.queueDepth > 0) && affectedAgentIds.has(status.agentId))
        .map((status) => status.agentId)
        .sort();
      if (activeAgentIds.length > 0) {
        throw new ProviderAccountError(
          409,
          `Initial Claude account continuity setup requires idle agents: ${activeAgentIds.join(', ')}`,
        );
      }
    }
    try {
      await this.ensureContinuity(continuityAccounts);
      if (current.id !== target.id) await this.synchronizeMcpState(current, target);
    } catch (error) {
      if (error instanceof ClaudeAccountContinuityError) {
        throw new ProviderAccountError(409, error.message);
      }
      throw error;
    }
    const previousRegistry = providerAccounts.claudeCode;
    const previousEffective = new Map(
      affectedAgents.map((agent) => [
        agent.id,
        applyClaudeAccountToAgent(agent, previousRegistry).provider.env?.CLAUDE_CONFIG_DIR,
      ]),
    );
    const requestedAt = new Date().toISOString();
    const restartAgentIds = retryAgentIds ?? affectedAgents
      .filter((agent) => {
        const next = applyClaudeAccountToAgent(agent, {
          accounts: registry.accounts,
          activeAccountId: target.id,
        });
        return previousEffective.get(agent.id) !== next.provider.env?.CLAUDE_CONFIG_DIR;
      })
      .map((agent) => agent.id)
      .sort();
    const nextRegistry: ClaudeCodeAccountRegistry = {
      accounts: registry.accounts,
      activeAccountId: target.id,
      switch: {
        accountId: target.id,
        agentIds: restartAgentIds,
        failedAgentIds: [],
        requestedAt,
        restarts: [],
      },
    };
    await this.settings.setProviderAccounts({ ...providerAccounts, claudeCode: nextRegistry });
    if (restartAgentIds.length === 0) return this.claudeState();

    const restarts: Array<{ agentId: string; requestId: string }> = [];
    const failedAgentIds: string[] = [];
    for (const agentId of restartAgentIds) {
      try {
        const restart = await this.runtime.reloadAgentWhenIdle(agentId);
        restarts.push({ agentId, requestId: restart.requestId });
      } catch {
        failedAgentIds.push(agentId);
      }
    }
    const latestProviderAccounts = await this.settings.getProviderAccounts();
    await this.settings.setProviderAccounts({
      ...latestProviderAccounts,
      claudeCode: {
        ...nextRegistry,
        switch: {
          accountId: target.id,
          agentIds: restartAgentIds,
          failedAgentIds,
          requestedAt,
          restarts,
        },
      },
    });
    return this.claudeState();
  }
}

function affectedClaudeAgent(agent: AgentConfig): boolean {
  return agent.enabled !== false && agent.provider.kind === 'claude-code' && isAgentRunnable(agent);
}

function accountSwitchState(
  registry: ClaudeCodeAccountRegistry,
  statuses: AgentStatusSummary[],
): Pick<ClaudeCodeAccountState, 'errorAgentIds' | 'pendingAgentIds' | 'status'> {
  if (!registry.switch || registry.switch.accountId !== registry.activeAccountId) {
    return { errorAgentIds: [], pendingAgentIds: [], status: 'active' };
  }
  const statusByAgent = new Map(statuses.map((status) => [status.agentId, status]));
  const errorAgentIds = [...(registry.switch.failedAgentIds ?? [])];
  const pendingAgentIds: string[] = [];
  const restartByAgent = new Map(registry.switch.restarts.map((restart) => [restart.agentId, restart]));
  const agentIds = registry.switch.agentIds ?? [...restartByAgent.keys()];
  for (const agentId of agentIds) {
    if (errorAgentIds.includes(agentId)) continue;
    const restart = restartByAgent.get(agentId);
    if (!restart) {
      errorAgentIds.push(agentId);
      continue;
    }
    const outcome = statusByAgent.get(restart.agentId)?.health?.restart;
    if (!outcome) {
      pendingAgentIds.push(restart.agentId);
      continue;
    }
    const supersedingOutcome = outcome.requestId !== restart.requestId
      && Date.parse(outcome.completedAt ?? '') >= Date.parse(registry.switch.requestedAt);
    if (outcome.requestId !== restart.requestId && !supersedingOutcome) {
      pendingAgentIds.push(restart.agentId);
    } else if (outcome.outcome === 'failed') {
      errorAgentIds.push(restart.agentId);
    } else if (outcome.outcome !== 'recovered') {
      pendingAgentIds.push(restart.agentId);
    }
  }
  return {
    errorAgentIds: errorAgentIds.sort(),
    pendingAgentIds: pendingAgentIds.sort(),
    status: errorAgentIds.length > 0 ? 'error' : pendingAgentIds.length > 0 ? 'switching' : 'active',
  };
}

export const defaultProviderAccountService = new ProviderAccountService();
