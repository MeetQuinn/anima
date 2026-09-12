import type { ContactDirectory, ContactWorkspace } from '../../shared/do-not-contact.js';
import { AgentRegistryService } from '../agents/agent.service.js';
import { AgentConfigError } from '../agents/agent-config-ops.js';
import { createSlackWebClient } from '../slack/client.js';
import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';
import { serverConfigStore, type ServerConfigStore } from '../storage/schema/server.store.js';

export class DoNotContactService {
  constructor(
    private readonly config: ServerConfigStore = serverConfigStore,
    private readonly agents: AgentRegistryService = new AgentRegistryService(),
  ) {}

  async list(): Promise<ContactWorkspace[]> {
    const [config, agents] = await Promise.all([this.config.read(), this.agents.listAgentConfigs()]);
    const workspaces = new Map<string, ContactWorkspace>();
    for (const [id, memberIds] of Object.entries(config.doNotContact ?? {})) {
      workspaces.set(id, { id, name: id, memberIds, canLookup: false });
    }
    for (const agent of agents) {
      const id = agent.slack.teamId;
      if (!id) continue;
      let workspace = workspaces.get(id);
      if (!workspace) {
        workspace = { id, name: id, memberIds: [], canLookup: false };
        workspaces.set(id, workspace);
      }
      if (agent.slack.workspaceName) workspace.name = agent.slack.workspaceName;
      if (agent.slack.botToken) workspace.canLookup = true;
    }
    return [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async directory(workspaceId: string): Promise<ContactDirectory> {
    const signal = AbortSignal.timeout(8_000);
    const agents = (await this.agents.listAgentConfigs())
      .filter((agent) => agent.slack.teamId === workspaceId && agent.slack.botToken)
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id));
    for (const agent of agents) {
      if (signal.aborted) break;
      try {
        const client = createSlackWebClient(agent.slack.botToken, {
          timeout: 4_000, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
          requestInterceptor: (config) => ({ ...config, signal }),
        });
        // Verify the token's workspace before touching the shared directory cache.
        // A stale configured teamId must never lend another workspace's identity.
        const identity = await client.auth.test();
        if (identity.team_id !== workspaceId) continue;
        const users = await new SlackWorkspaceDirectoryService({ client, teamId: workspaceId }).getUserCandidates();
        return { users };
      } catch {
        // Another connection in this workspace may still have directory access.
        // Do not expose SDK errors or credentials to the browser.
      }
    }
    throw new AgentConfigError(503, 'Slack directory unavailable. Check this workspace’s Slack connection and try again.');
  }

  async add(workspaceId: string, userId: string): Promise<void> {
    const { users } = await this.directory(workspaceId);
    if (!users.some((user) => user.slackUserId === userId)) {
      throw new AgentConfigError(400, 'Member could not be verified in this Slack workspace. Search again before adding.');
    }
    await this.config.update((config) => {
      const members = config.doNotContact?.[workspaceId] ?? [];
      if (members.includes(userId)) return config;
      return { ...config, doNotContact: { ...config.doNotContact, [workspaceId]: [...members, userId] } };
    });
  }

  async remove(workspaceId: string, userId: string): Promise<void> {
    // Removal must work for a retained ID even after its Slack connection is gone.
    await this.config.update((config) => {
      const members = config.doNotContact?.[workspaceId];
      if (!members?.includes(userId)) return config;
      return { ...config, doNotContact: { ...config.doNotContact, [workspaceId]: members.filter((id) => id !== userId) } };
    });
  }
}

export const defaultDoNotContactService = new DoNotContactService();
