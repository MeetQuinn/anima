import type { AgentStatusSummary } from '@shared/snapshot';

// Centralised TanStack Query key factory.
// All cache keys live here — cache dependencies are grep-able and typos are
// caught by the type checker.

export const queryKeys = {
  agents: () => ['agents'] as const,
  agent: (agentId: string) => ['agent', agentId] as const,
  agentStatuses: () => ['agent-statuses'] as const,
  agentActivities: (agentId: string) => ['agent-activities', agentId] as const,
  // Indicator-only activity slice: the live Working/Thinking label needs the
  // current item's latest activity even when the step layer is hidden. Distinct
  // key so it never collides with the infinite agentActivities feed.
  agentIndicatorActivity: (agentId: string) =>
    ['agent-activities', agentId, 'indicator'] as const,
  agentMessages: (agentId: string) => ['agent-messages', agentId] as const,
  // Channels detail pane: one channel's history, fetched server-side scoped to
  // the channel (not the global stream filtered client-side).
  agentChannelMessages: (agentId: string, channelId: string) =>
    ['agent-messages', agentId, 'channel', channelId] as const,
  agentChannels: (agentId: string) => ['agent-channels', agentId] as const,
  agentReminders: (agentId: string) => ['reminders', agentId] as const,
  agentSessions: (agentId: string) => ['agent-session', agentId] as const,
  agentSession: (agentId: string, currentItemId?: string) =>
    ['agent-session', agentId, currentItemId] as const,
  agentFeishuScopes: (agentId: string) => ['agent-feishu-scopes', agentId] as const,
  agentSlackManifestUpdate: (agentId: string) => ['agent-slack-manifest-update', agentId] as const,
  kbs: () => ['kbs'] as const,
  kb: (id: string) => ['kb', id] as const,
  kbTree: (id: string) => ['kb-tree', id] as const,
  kbFile: (id: string, filePath: string) => ['kb-file', id, filePath] as const,
  kbBrowse: (path: string) => ['kb-browse', path] as const,
  agentSkills: (agentId: string) => ['agent-skills', agentId] as const,
  providerAvailability: () => ['provider-availability'] as const,
  providerUsage: () => ['provider-usage'] as const,
  health: () => ['health'] as const,
  serverInfo: () => ['server-info'] as const,
  sidebarOrder: () => ['sidebar-order'] as const,
  teams: () => ['teams'] as const,
  workspacePlatform: () => ['workspace-platform'] as const,
  runtimeUpgrade: () => ['runtime-upgrade'] as const,
};

export const refetchIntervals = {
  agentStatuses: (query: { state: { data?: unknown } }) =>
    hasTransientAgentStatus(query.state.data) ? 2_000 : 5_000,
  agentActivities: 3_000,
} as const;

function hasTransientAgentStatus(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return (value as AgentStatusSummary[]).some((status) => {
    const health = status.health;
    return Boolean(
      health?.state === 'starting' ||
      health?.state === 'degraded' ||
      health?.reason === 'restart_pending' ||
      health?.restart?.outcome === 'pending',
    );
  });
}
