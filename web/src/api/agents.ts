import { queryClient } from '@/query-client';
import { queryKeys } from '@/lib/query-keys';
import { apiRequest, jsonInit } from './client';
import type {
  AgentConfig,
  AgentConnectFeishuRequest,
  AgentFeishuScopeStatus,
  AgentFeishuRegisterAppRequest,
  AgentFeishuRegisterAppStatus,
  AgentConnectSlackRequest,
  AgentCreateRequest,
  AgentSetOwnerRequest,
  AgentUpdateHomeRequest,
  AgentUpdateProfileRequest,
  AgentUpdateProviderRequest,
  SlackUserCandidate,
} from '@shared/agent-config';
import type { Reminder } from '@shared/reminder';
import type { Activity, AgentActivityFeedEvent, AgentActivityFeedPage } from '@shared/activity';
import type { AgentDiagnosticsBundle } from '@shared/diagnostics';
import type { InboxItem } from '@shared/inbox';
import type {
  AgentChannelListResponse,
  AgentMessageDirection,
  AgentMessageHistoryPage,
} from '@shared/messages';
import type {
  AgentSessionSummary,
  AgentStatusSummary,
  ArchivedProviderSessionRecord,
} from '@shared/snapshot';
import type { AgentSkills } from '@shared/skills';
import type {
  AgentSlackManifestUpdateInfo,
  AgentSlackManifestUpgradeRequest,
} from '@shared/slack-manifest';

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export async function createAgent(input: AgentCreateRequest): Promise<AgentConfig> {
  return apiRequest('/api/agents', jsonInit('POST', input));
}

export async function updateAgentHome(
  id: string,
  input: AgentUpdateHomeRequest,
): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/home`, jsonInit('POST', input));
}

export async function updateAgentProfile(
  id: string,
  input: AgentUpdateProfileRequest,
): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/profile`, jsonInit('POST', input));
}

export async function updateAgentProvider(
  id: string,
  input: AgentUpdateProviderRequest,
): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/provider`, jsonInit('POST', input));
}

export async function enableAgent(id: string): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/enable`, jsonInit('POST'));
}

export async function disableAgent(id: string): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/disable`, jsonInit('POST'));
}

// ---------------------------------------------------------------------------
// Slack token validation
// ---------------------------------------------------------------------------

export interface SlackTokenValidation {
  valid: boolean;
  expected: 'app' | 'bot';
  detected?: 'app' | 'bot' | 'unknown';
  reason?:
    | 'missing_token'
    | 'wrong_token_type'
    | 'unknown_token_type'
    | 'invalid_token'
    | 'missing_connections_write'
    | 'not_bot_token'
    | 'slack_api_error';
  appId?: string;
  teamId?: string;
  workspaceName?: string;
  workspaceIconUrl?: string;
  botUserId?: string;
  botName?: string;
  botAvatarUrl?: string;
}

export interface SlackValidateResponse {
  app?: SlackTokenValidation;
  bot?: SlackTokenValidation;
  connection: {
    valid: boolean;
    reason?: 'incomplete' | 'app_mismatch';
    appId?: string;
    teamId?: string;
    workspaceName?: string;
    workspaceIconUrl?: string;
    botUserId?: string;
    botName?: string;
    botAvatarUrl?: string;
  };
}

export async function validateAgentSlackTokens(
  id: string,
  tokens: { appToken?: string; botToken?: string },
): Promise<SlackValidateResponse> {
  return apiRequest(
    `/api/agents/${encodeURIComponent(id)}/slack/tokens/validate`,
    jsonInit('POST', tokens),
  );
}

export async function connectAgentSlack(
  id: string,
  input: AgentConnectSlackRequest,
): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/slack/connect`, jsonInit('POST', input));
}

export async function connectAgentFeishu(
  id: string,
  input: AgentConnectFeishuRequest,
): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/feishu/connect`, jsonInit('POST', input));
}

export async function startAgentFeishuAppRegistration(
  id: string,
  input: AgentFeishuRegisterAppRequest = {},
): Promise<AgentFeishuRegisterAppStatus> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/feishu/register-app`, jsonInit('POST', input));
}

export async function fetchAgentFeishuAppRegistration(
  id: string,
  registrationId: string,
): Promise<AgentFeishuRegisterAppStatus> {
  return apiRequest(
    `/api/agents/${encodeURIComponent(id)}/feishu/register-app/${encodeURIComponent(registrationId)}`,
  );
}

export async function fetchAgentFeishuScopeStatus(id: string): Promise<AgentFeishuScopeStatus> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/feishu/scopes`);
}

export async function fetchAgentSlackManifestUpdate(id: string): Promise<AgentSlackManifestUpdateInfo> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/slack/manifest-update`);
}

export async function upgradeAgentSlackManifest(
  id: string,
  input: AgentSlackManifestUpgradeRequest,
): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/slack/manifest-upgrade`, jsonInit('POST', input));
}

export async function fetchAgentSlackUsers(id: string): Promise<SlackUserCandidate[]> {
  const body = await apiRequest<{ users: SlackUserCandidate[] }>(
    `/api/agents/${encodeURIComponent(id)}/slack/users`,
  );
  return body.users;
}

export async function setAgentOwner(
  id: string,
  input: AgentSetOwnerRequest,
): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}/slack/owner`, jsonInit('POST', input));
}

export async function removeAgent(id: string): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function fetchAgents(): Promise<AgentConfig[]> {
  return apiRequest('/api/agents');
}

export async function fetchAgent(agentId: string): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}`);
}

export async function fetchAgentStatuses(): Promise<AgentStatusSummary[]> {
  return apiRequest('/api/agent-statuses');
}

export async function fetchAgentDiagnostics(agentId: string): Promise<AgentDiagnosticsBundle> {
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/diagnostics`);
}

// Invalidates all active queries so the UI re-fetches without a full page reload.
export function refreshDashboardData(): void {
  queryClient.invalidateQueries({ queryKey: queryKeys.agents() });
  queryClient.invalidateQueries({ queryKey: queryKeys.agentStatuses() });
}

export function refreshAgentData(agentId: string): void {
  queryClient.invalidateQueries({ queryKey: queryKeys.agent(agentId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.agentSessions(agentId) });
  refreshDashboardData();
}

// Like refreshDashboardData but awaits the agents refetch.
// Use before navigating to a newly-created agent so AgentReconciler sees it.
export async function awaitAgentsRefresh(): Promise<void> {
  await queryClient.refetchQueries({ queryKey: queryKeys.agents() });
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface RotateSessionResult {
  agentId: string;
  archivedAt: string;
  archivedProviderSessions: ArchivedProviderSessionRecord[];
  itemId: string;
}

export async function rotateAgentSession(
  agentId: string,
  note?: string,
): Promise<RotateSessionResult> {
  return apiRequest(
    `/api/agents/${encodeURIComponent(agentId)}/session/rotate`,
    jsonInit('POST', note ? { note } : {}),
  );
}

// Hard-restart a hung agent. The in-flight item is dropped (not requeued);
// memory, notes, config, and queued items are preserved. Backend returns 202
// with a requestId; a 409 ("Agent is disabled. Enable it to run.") surfaces
// via apiRequest's thrown error if the agent is disabled.
export async function restartAgent(agentId: string): Promise<{ ok: boolean; requestId: string }> {
  return apiRequest(
    `/api/agents/${encodeURIComponent(agentId)}/restart`,
    jsonInit('POST'),
  );
}

export async function fetchAgentActivities(
  agentId: string,
  limit = 100,
  before?: string,
): Promise<AgentActivityFeedPage> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set('before', before);
  const body = await apiRequest<unknown>(`/api/agents/${encodeURIComponent(agentId)}/activities?${params.toString()}`);
  return normalizeAgentActivityFeedPage(body);
}

export async function fetchAgentMessages(
  agentId: string,
  input: {
    before?: string;
    direction?: AgentMessageDirection;
    limit?: number;
  } = {},
): Promise<AgentMessageHistoryPage> {
  const params = new URLSearchParams({ limit: String(input.limit ?? 100) });
  if (input.before) params.set('before', input.before);
  if (input.direction) params.set('direction', input.direction);
  return apiRequest<AgentMessageHistoryPage>(
    `/api/agents/${encodeURIComponent(agentId)}/messages?${params.toString()}`,
  );
}

// Channels tab: the Slack channels + DMs the agent is a member of (membership is
// authoritative `is_member`, includes muted + silent; DMs folded from history).
export async function fetchAgentChannels(agentId: string): Promise<AgentChannelListResponse> {
  return apiRequest<AgentChannelListResponse>(
    `/api/agents/${encodeURIComponent(agentId)}/subscriptions`,
  );
}

interface LegacyAgentActivitiesResponse {
  activities?: Activity[];
  items?: InboxItem[];
  nextCursor?: string | null;
}

function normalizeAgentActivityFeedPage(body: unknown): AgentActivityFeedPage {
  if (!body || typeof body !== 'object') return { events: [], nextCursor: null };
  const record = body as Partial<AgentActivityFeedPage> & LegacyAgentActivitiesResponse;
  if (Array.isArray(record.events)) {
    return {
      events: record.events,
      nextCursor: record.nextCursor ?? null,
    };
  }
  const events: AgentActivityFeedEvent[] = [
    ...(Array.isArray(record.activities)
      ? record.activities.map((activity) => ({
          activity,
          kind: 'activity' as const,
          timestamp: activity.createdAt,
        }))
      : []),
    ...(Array.isArray(record.items)
      ? record.items.map((item) => ({
          item,
          kind: 'inbox' as const,
          timestamp: item.receivedAt,
        }))
      : []),
  ];
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return {
    events,
    nextCursor: record.nextCursor ?? null,
  };
}

export async function fetchAgentSession(agentId: string): Promise<AgentSessionSummary | null> {
  try {
    return await apiRequest<AgentSessionSummary>(`/api/agents/${encodeURIComponent(agentId)}/session`);
  } catch (err) {
    // 404 = agent has no session yet (normal for new agents).
    if (err instanceof Error && err.message.includes('404')) return null;
    throw err;
  }
}

export async function fetchAgentReminders(agentId: string): Promise<Reminder[]> {
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/reminders`);
}

// ---------------------------------------------------------------------------
// Avatar + lifecycle
// ---------------------------------------------------------------------------

export async function syncAgentAvatar(agentId: string): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/slack/sync-avatar`, { method: 'POST' });
}

export async function syncAgentFeishuAvatar(agentId: string): Promise<AgentConfig> {
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/feishu/sync-avatar`, { method: 'POST' });
}

export async function stopItem(agentId: string): Promise<void> {
  await apiRequest(`/api/agents/${encodeURIComponent(agentId)}/stop`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export async function fetchAgentSkills(agentId: string): Promise<AgentSkills> {
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/skills`);
}
