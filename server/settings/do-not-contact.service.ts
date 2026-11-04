import { z } from 'zod';
import type { AgentConfig } from '../../shared/agent-config.js';
import type { ContactDirectory, ContactWorkspace, LinearContactCandidate, LinearContactDirectory } from '../../shared/do-not-contact.js';
import { AgentRegistryService } from '../agents/agent.service.js';
import { AgentConfigError } from '../agents/agent-config-ops.js';
import { LinearClient } from '../linear/client.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { createSlackWebClient } from '../slack/client.js';
import { LinearStore } from '../storage/schema/linear.store.js';
import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';
import { serverConfigStore, type ServerConfigStore } from '../storage/schema/server.store.js';

// People only: app users (agents, integrations) are filtered out. Email is never requested.
const LINEAR_DIRECTORY_QUERY = 'query($after:String) { organization { id } users(filter:{app:{eq:false}},first:250,after:$after) { nodes { id name displayName avatarUrl app } pageInfo { hasNextPage endCursor } } }';
const LinearDirectoryPage = z.object({
  organization: z.object({ id: z.string() }),
  users: z.object({
    nodes: z.array(z.object({ id: z.string().uuid(), name: z.string(), displayName: z.string(), avatarUrl: z.string().nullish(), app: z.boolean() })),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  }),
});
const LINEAR_DIRECTORY_PAGES = 40;

export class DoNotContactService {
  constructor(
    private readonly config: ServerConfigStore = serverConfigStore,
    private readonly agents: AgentRegistryService = new AgentRegistryService(),
  ) {}

  async list(): Promise<ContactWorkspace[]> {
    const [config, agents] = await Promise.all([this.config.read(), this.agents.listAgentConfigs()]);
    const workspaces = new Map<string, ContactWorkspace>();
    for (const [id, memberIds] of Object.entries(config.doNotContact ?? {})) {
      workspaces.set(id, { platform: 'slack', id, name: id, memberIds, canLookup: false });
    }
    for (const agent of agents) {
      const id = agent.slack.teamId;
      if (!id) continue;
      let workspace = workspaces.get(id);
      if (!workspace) {
        workspace = { platform: 'slack', id, name: id, memberIds: [], canLookup: false };
        workspaces.set(id, workspace);
      }
      if (agent.slack.workspaceName) workspace.name = agent.slack.workspaceName;
      if (agent.slack.botToken) workspace.canLookup = true;
    }
    const linear = await this.linearWorkspaces(config.linearDoNotContact ?? {}, agents);
    const byName = (a: ContactWorkspace, b: ContactWorkspace) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    return [...[...workspaces.values()].sort(byName), ...linear.sort(byName)];
  }

  /** Saved lists plus every Linear organization an agent on this host is connected to. */
  private async linearWorkspaces(lists: Record<string, string[]>, agents: AgentConfig[]): Promise<ContactWorkspace[]> {
    const workspaces = new Map<string, ContactWorkspace>();
    const workspace = (id: string) => {
      let found = workspaces.get(id);
      if (!found) { found = { platform: 'linear', id, name: id, memberIds: [], canLookup: false }; workspaces.set(id, found); }
      return found;
    };
    for (const [id, memberIds] of Object.entries(lists)) {
      const entry = workspace(id.toLowerCase());
      entry.memberIds = [...new Set([...entry.memberIds, ...memberIds.map((member) => member.toLowerCase())])];
    }
    const connected = agents.filter((agent) => agent.linear?.organizationId);
    const installations = await Promise.all(connected.map((agent) => new LinearStore(agent.id).read().then((file) => file.installation, () => undefined)));
    connected.forEach((agent, index) => {
      const id = agent.linear!.organizationId.toLowerCase();
      const entry = workspace(id);
      const installation = installations[index];
      if (installation?.organizationId.toLowerCase() !== id) return;
      if (installation.workspaceName) entry.name = installation.workspaceName;
      if (agent.enabled && agent.linear!.connected && !installation.revoked) entry.canLookup = true;
    });
    return [...workspaces.values()];
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

  /**
   * The people in a Linear organization, read with a connected agent's own token on the
   * server. Sends nothing and wakes no agent; the token never leaves the server.
   */
  async linearDirectory(organizationId: string): Promise<LinearContactDirectory> {
    const budget = AbortSignal.timeout(8_000);
    const fetcher: typeof fetch = (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, budget]) : budget });
    const agents = (await this.agents.listAgentConfigs())
      .filter((agent) => agent.enabled && agent.linear?.connected && agent.linear.organizationId.toLowerCase() === organizationId)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const agent of agents) {
      if (budget.aborted) break;
      try {
        const identity = new LinearIdentityService(agent.id, new LinearClient(fetcher));
        const users: LinearContactCandidate[] = [];
        let after: string | null = null;
        for (let page = 0; page < LINEAR_DIRECTORY_PAGES; page++) {
          const result: z.infer<typeof LinearDirectoryPage> = await identity.request(LINEAR_DIRECTORY_QUERY, { after }, LinearDirectoryPage);
          // A stale configured organization must never lend another workspace's people.
          if (result.organization.id.toLowerCase() !== organizationId) throw new Error('Linear organization mismatch');
          for (const user of result.users.nodes) if (!user.app) users.push(linearCandidate(user));
          if (!result.users.pageInfo.hasNextPage || !result.users.pageInfo.endCursor) break;
          after = result.users.pageInfo.endCursor;
        }
        return { users: users.sort((a, b) => a.name.localeCompare(b.name) || a.linearUserId.localeCompare(b.linearUserId)) };
      } catch {
        // Another agent connected to this organization may still be able to read it.
        // Do not expose Linear errors or credentials to the browser.
      }
    }
    throw new AgentConfigError(503, 'Linear directory unavailable. Check this workspace’s Linear connection and try again.');
  }

  async addLinear(organizationId: string, userId: string): Promise<void> {
    const { users } = await this.linearDirectory(organizationId);
    if (!users.some((user) => user.linearUserId === userId)) {
      throw new AgentConfigError(400, 'Member could not be verified in this Linear workspace. Search again before adding.');
    }
    await this.config.update((config) => {
      const lists = config.linearDoNotContact ?? {};
      const key = Object.keys(lists).find((id) => id.toLowerCase() === organizationId) ?? organizationId;
      const members = lists[key] ?? [];
      if (members.some((id) => id.toLowerCase() === userId)) return config;
      return { ...config, linearDoNotContact: { ...lists, [key]: [...members, userId] } };
    });
  }

  async removeLinear(organizationId: string, userId: string): Promise<void> {
    // Removal must work for a retained ID even after its Linear connection is gone.
    await this.config.update((config) => {
      const lists = config.linearDoNotContact ?? {};
      const key = Object.keys(lists).find((id) => id.toLowerCase() === organizationId);
      const members = key === undefined ? undefined : lists[key];
      if (key === undefined || !members?.some((id) => id.toLowerCase() === userId)) return config;
      return { ...config, linearDoNotContact: { ...lists, [key]: members.filter((id) => id.toLowerCase() !== userId) } };
    });
  }
}

function linearCandidate(user: z.infer<typeof LinearDirectoryPage>['users']['nodes'][number]): LinearContactCandidate {
  // Linear can fall back to an email address for a person without a name; never show one.
  const name = user.name.trim() && !user.name.includes('@') ? user.name.trim() : user.displayName;
  const avatarUrl = user.avatarUrl?.startsWith('https://') ? user.avatarUrl : undefined;
  return { linearUserId: user.id.toLowerCase(), name, displayName: user.displayName, ...(avatarUrl ? { avatarUrl } : {}) };
}

export const defaultDoNotContactService = new DoNotContactService();
