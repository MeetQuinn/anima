import { apiRequest } from './client';
import type { KbFile } from '@shared/kb';

// One node of the agent-home manifest. Flat, recursive, home-relative POSIX
// paths. `kind` is the file-vs-dir discriminator (NOT a KbFileKind) — the
// display kind/icon is derived client-side via the shared `kbFileKind(name)`
// so one classifier runs on both ends.
export interface AgentHomeEntry {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  ext?: string;
  size?: number;
  // File lstat mtime, ISO 8601 UTC. Dirs carry none — the tree builder derives
  // a dir's "latest change inside" from its descendants (GitHub semantics).
  mtime?: string;
}

export interface AgentHomeManifest {
  root: string; // resolved absolute homePath — the "Files in this agent's home" header
  entries: AgentHomeEntry[];
  truncated: boolean; // structural cap (5,000 entries) hit
}

// File payload is KbFile-shaped minus `kbId` (agentId comes from the route).
// `kind` here IS a KbFileKind — the same value the KB renderer switches on.
export type AgentHomeFile = Omit<KbFile, 'kbId'>;

export async function fetchAgentHomeManifest(agentId: string): Promise<AgentHomeManifest> {
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/home/files`);
}

export async function fetchAgentHomeFile(
  agentId: string,
  filePath: string,
): Promise<AgentHomeFile> {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/home/files/${encoded}`);
}
