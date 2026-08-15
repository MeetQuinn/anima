import { apiRequest } from './client';
import type { KbFile } from '@shared/kb';

// One node of a single directory listing. Paths are home-relative POSIX.
// `kind` is file-vs-dir (NOT a KbFileKind) — display kind/icon is derived
// client-side via shared `kbFileKind(name)`.
export interface AgentHomeEntry {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  ext?: string;
  size?: number;
  // File lstat mtime, ISO 8601 UTC. Dirs carry none.
  mtime?: string;
}

// Shallow listing for one directory. The Files tab lazy-loads children when a
// folder is expanded so a huge node_modules under home no longer caps the root.
export interface AgentHomeDirectory {
  root: string; // resolved absolute homePath
  dir: string; // '' for home root; otherwise home-relative POSIX dir
  entries: AgentHomeEntry[];
  truncated: boolean; // this directory alone hit the per-listing cap
}

// File payload is KbFile-shaped minus `kbId` (agentId comes from the route).
// `kind` here IS a KbFileKind — the same value the KB renderer switches on.
export type AgentHomeFile = Omit<KbFile, 'kbId'>;

export async function fetchAgentHomeDirectory(
  agentId: string,
  dir = '',
): Promise<AgentHomeDirectory> {
  const qs = dir ? `?dir=${dir.split('/').map(encodeURIComponent).join('/')}` : '';
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/home/files${qs}`);
}

export async function fetchAgentHomeFile(
  agentId: string,
  filePath: string,
): Promise<AgentHomeFile> {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return apiRequest(`/api/agents/${encodeURIComponent(agentId)}/home/files/${encoded}`);
}
