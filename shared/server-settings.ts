import { z } from 'zod';

import { ProviderAccountsConfig } from './provider-accounts.js';

export const SidebarOrder = z.object({
  agents: z.array(z.string()).optional(),
  kbs: z.array(z.string()).optional(),
  teams: z.array(z.string()).optional(),
});
export type SidebarOrder = z.infer<typeof SidebarOrder>;

// Team = a first-class organizational grouping: a set of member agents + a KB (`home`).
// Soft grouping with default mutual visibility, NOT an isolation/permission boundary.
// Agents carry only `teamId`; the mutable name/home live here in the registry so they can
// change without rewriting every agent config. See docs/design/team-first-class-cut1.md.
export const DEFAULT_TEAM_ID = 'default';
export const DEFAULT_TEAM_NAME = 'Default';

export const TeamConfig = z.object({
  // Stable id (never regenerated). The default team's id is always `default`.
  id: z.string().min(1),
  // Display name; renamable without touching agents.
  name: z.string().min(1),
  // The team's KB root ($TEAM_HOME): the inhabited tree whose `agents/*` subdirs hold member
  // agent homes. Stored as written (may be `~/...` or absolute); resolved at the server
  // boundary when deriving `$TEAM_HOME/agents/$AGENT_NAME`.
  home: z.string().min(1),
}).strict();
export type TeamConfig = z.infer<typeof TeamConfig>;

// A repairable config diagnostic: an agent whose `teamId` names a team that no longer exists.
// The read path folds it into the default team (never crashes) and emits this so the dashboard
// can surface a repair cue, per the locked runtime contract (degrade AND warn).
export interface AgentTeamWarning {
  agentId: string;
  // The dangling team id exactly as configured.
  teamId: string;
  // Where the agent was folded (the default team, in cut-1).
  effectiveTeamId: string;
  // Operator-facing repair message.
  message: string;
}

export const ReleaseTrack = z.enum(['stable', 'canary']);
export type ReleaseTrack = z.infer<typeof ReleaseTrack>;

export const ServerTrack = z.enum(['dev', 'canary', 'stable']);
export type ServerTrack = z.infer<typeof ServerTrack>;

export const WorkspacePlatform = z.enum(['slack', 'feishu']);
export type WorkspacePlatform = z.infer<typeof WorkspacePlatform>;

export { ProviderAccountsConfig };

export const DEFAULT_MEMORY_COHERENCE_CONSOLIDATION_THRESHOLD_BYTES = 16 * 1024;

export const DashboardAuth = z.object({
  enabled: z.boolean().optional(),
  passwordHash: z.string().min(1).optional(),
  sessionSecret: z.string().min(16).optional(),
  sessionTtlHours: z.number().int().positive().max(24 * 365).optional(),
}).strict();
export type DashboardAuth = z.infer<typeof DashboardAuth>;

export const MemoryCoherenceConfig = z.object({
  consolidationThresholdBytes: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().int().positive().max(100).optional(),
  scopeAgentIds: z.array(z.string().min(1)).optional(),
  timezone: z.string().min(1).optional(),
  windowDurationMinutes: z.number().int().positive().max(24 * 60).optional(),
  windowStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
}).strict();
export type MemoryCoherenceConfig = z.infer<typeof MemoryCoherenceConfig>;
