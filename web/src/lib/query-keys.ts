// Centralised TanStack Query key factory.
// All cache keys live here — cache dependencies are grep-able and typos are
// caught by the type checker.

export const queryKeys = {
  agents: () => ['agents'] as const,
  agent: (agentId: string) => ['agent', agentId] as const,
  agentStatuses: () => ['agent-statuses'] as const,
  agentActivities: (agentId: string) => ['agent-activities', agentId] as const,
  agentMessages: (agentId: string, dir: string) => ['agent-messages', agentId, dir] as const,
  agentReminders: (agentId: string) => ['reminders', agentId] as const,
  agentSessions: (agentId: string) => ['agent-session', agentId] as const,
  agentSession: (agentId: string, currentItemId?: string) =>
    ['agent-session', agentId, currentItemId] as const,
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
  runtimeUpgrade: () => ['runtime-upgrade'] as const,
};

export const refetchIntervals = {
  agentStatuses: 5_000,
  agentActivities: 3_000,
} as const;
