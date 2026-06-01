import type { WebClient } from '@slack/web-api';

import {
  type AgentConnectSlackRequest,
  type AgentConfig,
  type AgentSetOwnerRequest,
  type AgentSlackValidateRequest,
  type AgentSlackValidateResponse,
  type SlackUserCandidate,
} from '../../shared/agent-config.js';
import {
  CURRENT_SLACK_MANIFEST_VERSION,
  type AgentSlackManifestUpdateInfo,
  type AgentSlackManifestUpgradeRequest,
} from '../../shared/slack-manifest.js';
import { AgentConfigError } from './agent-config-ops.js';
import { AgentService } from './agent.service.js';
import {
  appIdFromAppToken,
  getBotTokenScopes,
  getSlackDisplayInfo,
  validateSlackTokenPair,
} from './agent-slack-validation.js';
import { nowIso } from '../ids.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import {
  slackAppInstallUrl,
  slackAppManifestUrl,
  slackAppManifestYaml,
} from '../slack/app-manifest.js';
import { createSlackWebClient } from '../slack/client.js';
import {
  hasCommandsScope,
} from '../slack/shortcuts.js';
import { SlackWorkspaceDirectoryService } from '../slack/workspace-directory.service.js';

export class AgentSlackService {
  constructor(private readonly agentService: AgentService) {}

  // Per-agent Slack workflows. Lower-level Slack details stay private here.
  async validateTokens(
    input: AgentSlackValidateRequest,
  ): Promise<AgentSlackValidateResponse> {
    return validateSlackTokenPair(input);
  }

  async connect(input: AgentConnectSlackRequest): Promise<AgentConfig> {
    const validation = await validateSlackTokenPair(input);
    if (!validation.connection.valid) {
      throw new AgentConfigError(400, 'Slack token validation failed');
    }
    const connection = validation.connection;
    const hasCurrentManifest = hasCommandsScope(await getBotTokenScopes(input.botToken).catch(() => []));
    const current = await this.agentService.getConfig();
    return this.agentService.saveConfig({
      ...current,
      slack: {
        ...current.slack,
        appId: connection.appId || '',
        appToken: input.appToken,
        avatarUrl: connection.botAvatarUrl || '',
        botToken: input.botToken,
        manifestVersion: hasCurrentManifest ? CURRENT_SLACK_MANIFEST_VERSION : 0,
        teamId: connection.teamId || '',
        workspaceIconUrl: connection.workspaceIconUrl || '',
        workspaceName: connection.workspaceName || '',
      },
    });
  }

  async getManifestUpdateInfo(): Promise<AgentSlackManifestUpdateInfo> {
    const agent = await this.agentService.getConfig();
    const appId = agent.slack.appId || appIdFromAppToken(agent.slack.appToken);
    const agentVersion = agent.slack.manifestVersion ?? 0;
    return {
      agentVersion,
      ...(appId ? {
        appManifestUrl: slackAppManifestUrl(appId, agent.slack.teamId),
        reinstallUrl: slackAppInstallUrl(appId),
      } : {}),
      currentVersion: CURRENT_SLACK_MANIFEST_VERSION,
      manifestUpdateYaml: await slackAppManifestYaml(agent),
      needsUpdate: agentVersion < CURRENT_SLACK_MANIFEST_VERSION,
    };
  }

  async upgradeManifestVersion(
    input: AgentSlackManifestUpgradeRequest,
  ): Promise<AgentConfig> {
    const agent = await this.agentService.getConfig();
    if (!agent.slack.appToken) {
      throw new AgentConfigError(400, `Agent ${agent.id} has no app token configured`);
    }
    const validation = await validateSlackTokenPair({
      appToken: agent.slack.appToken,
      botToken: input.botToken,
    });
    if (!validation.connection.valid) {
      throw new AgentConfigError(400, 'Slack token validation failed');
    }
    const scopes = await getBotTokenScopes(input.botToken);
    if (!hasCommandsScope(scopes)) {
      throw new AgentConfigError(
        400,
        'New bot token is missing the commands scope. Update the Slack app manifest, reinstall the app, then paste the new Bot User OAuth Token.',
      );
    }

    const connection = validation.connection;
    return this.agentService.saveConfig({
      ...agent,
      slack: {
        ...agent.slack,
        appId: connection.appId || agent.slack.appId || '',
        avatarUrl: connection.botAvatarUrl || '',
        botToken: input.botToken,
        manifestVersion: CURRENT_SLACK_MANIFEST_VERSION,
        teamId: connection.teamId || '',
        workspaceIconUrl: connection.workspaceIconUrl || '',
        workspaceName: connection.workspaceName || '',
      },
    });
  }

  async syncDisplayInfo(): Promise<AgentConfig> {
    const agent = await this.agentService.getConfig();
    return this.persistDisplayInfo(agent, await getSlackDisplayInfo(await this.getWebClient()));
  }

  /**
   * Refresh the bot's Slack display info (avatar, name, workspace icon) at most
   * once per `ttlMs`, stamping `slack.botProfileSyncedAt`. When the last sync is
   * still fresh this is a cheap no-op — it reads the local config only and makes
   * NO Slack API calls. Best-effort: callers run it fire-and-forget off the
   * message path and swallow errors. Pass an existing `client` to reuse the
   * inbound request's WebClient instead of building a new one.
   */
  async syncDisplayInfoIfStale(options: { client?: WebClient; ttlMs: number }): Promise<{ synced: boolean }> {
    const agent = await this.agentService.getConfig();
    if (!agent.slack.botToken) return { synced: false };
    if (isWithinTtl(agent.slack.botProfileSyncedAt, options.ttlMs)) return { synced: false };
    const client = options.client ?? this.webClientForAgent(agent);
    await this.persistDisplayInfo(agent, await getSlackDisplayInfo(client), nowIso());
    return { synced: true };
  }

  private async persistDisplayInfo(
    agent: AgentConfig,
    info: Awaited<ReturnType<typeof getSlackDisplayInfo>>,
    botProfileSyncedAt?: string,
  ): Promise<AgentConfig> {
    const appId = info.appId ?? appIdFromAppToken(agent.slack.appToken);
    return this.agentService.saveConfig({
      ...agent,
      slack: {
        ...agent.slack,
        ...info,
        ...(appId ? { appId } : {}),
        ...(botProfileSyncedAt ? { botProfileSyncedAt } : {}),
      },
    });
  }

  async getWebClient(): Promise<WebClient> {
    return (await this.getAgentWebClient()).client;
  }

  async getAgentWebClient(): Promise<{ agent: AgentConfig; client: WebClient }> {
    const agent = await this.agentService.getConfig();
    return { agent, client: this.webClientForAgent(agent) };
  }

  private webClientForAgent(agent: AgentConfig): WebClient {
    return createSlackWebClient(requireBotToken(agent));
  }

  async fetchPrivateUrl(url: string): Promise<Response> {
    const agent = await this.agentService.getConfig();
    return fetch(url, { headers: { Authorization: `Bearer ${requireBotToken(agent)}` } });
  }

  async listUsers(): Promise<SlackUserCandidate[]> {
    const { agent, client } = await this.getAgentWebClient();
    return new SlackWorkspaceDirectoryService({ client, teamId: agent.slack.teamId }).getUserCandidates();
  }

  async setOwner(input: AgentSetOwnerRequest): Promise<AgentConfig> {
    const agent = await this.agentService.getConfig();
    const client = this.webClientForAgent(agent);
    const candidates = await new SlackWorkspaceDirectoryService({ client, teamId: agent.slack.teamId }).getUserCandidates();
    const owner = candidates.find((user) => user.slackUserId === input.slackUserId);
    if (!owner) throw new AgentConfigError(400, `Slack user not found: ${input.slackUserId}`);

    const introduce = input.introduce !== false; // default true
    const onboardingPromptedAt = introduce
      ? await this.ensureOwnerOnboardingPrompt(agent, owner, input.openerNote)
      : (agent.owner?.slackUserId === owner.slackUserId ? agent.owner.onboardingPromptedAt : undefined);

    return this.agentService.saveConfig({
      ...agent,
      owner: { ...owner, ...(onboardingPromptedAt ? { onboardingPromptedAt } : {}) },
    });
  }

  async getInstallUrl(): Promise<string> {
    const agent = await this.agentService.getConfig();
    const manifestYaml = await slackAppManifestYaml(agent);
    return `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(manifestYaml)}`;
  }

  private async ensureOwnerOnboardingPrompt(
    agent: AgentConfig,
    owner: SlackUserCandidate,
    openerNote?: string,
  ): Promise<string> {
    const existingPromptedAt =
      agent.owner?.slackUserId === owner.slackUserId ? agent.owner.onboardingPromptedAt : undefined;
    if (existingPromptedAt) return existingPromptedAt;

    const client = await this.getWebClient();
    const auth = await client.auth.test();
    if (!auth.team_id) throw new AgentConfigError(502, 'Slack auth.test did not return a team id');
    const dm = await new SlackWorkspaceDirectoryService({ client, teamId: auth.team_id }).openDm(owner.slackUserId);
    if (!dm.id) throw new AgentConfigError(502, `Slack did not return a DM channel for ${owner.slackUserId}`);

    const mention = `<@${owner.slackUserId}>`;
    const ownerName = owner.displayName?.trim()
      || ownerHandleLabel(owner.handle)
      || mention;
    const now = nowIso();
    const textLines = [
      ownerName === mention
        ? `You've been set up here. Your owner is ${mention}.`
        : `You've been set up here. Your owner is ${ownerName} (${mention}).`,
    ];
    if (openerNote?.trim()) {
      textLines.push(
        `Context from whoever set you up (might be ${ownerName}, might be someone else): ${openerNote.trim()}`,
      );
      textLines.push(
        `Treat this as their intent, not fact — confirm with ${ownerName} what they actually need.`,
      );
    }
    textLines.push(
      `Start by reading your MEMORY.md — its Onboarding section walks you through getting set up — then reply here to introduce yourself to ${ownerName}.`,
    );
    await new WakeQueueService(agent.id).enqueue({
      channelId: dm.id,
      handling: { createdAt: now, queuedAt: now, status: 'queued', updatedAt: now },
      id: `agent-onboarding:${agent.id}:${owner.slackUserId}`,
      kind: 'onboarding',
      operator: {
        displayName: owner.displayName,
        ...(owner.handle ? { handle: owner.handle } : {}),
        slackUserId: owner.slackUserId,
      },
      receivedAt: now,
      teamId: auth.team_id,
      text: textLines.join('\n'),
    });
    return now;
  }

}

export function agentSlackServiceForAgent(agentId: string): AgentSlackService {
  return new AgentSlackService(new AgentService(agentId));
}

// True when `iso` is a valid timestamp within `ttlMs` of now. Unset/unparseable
// timestamps and a non-positive ttl are treated as stale so a sync still runs.
function isWithinTtl(iso: string | undefined, ttlMs: number): boolean {
  if (!iso || ttlMs <= 0) return false;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return false;
  return Date.now() - then < ttlMs;
}

function requireBotToken(agent: AgentConfig): string {
  const token = agent.slack.botToken;
  if (!token) throw new AgentConfigError(400, `Agent ${agent.id} has no bot token configured`);
  return token;
}

function ownerHandleLabel(handle: string | undefined): string | undefined {
  const trimmed = handle?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}
