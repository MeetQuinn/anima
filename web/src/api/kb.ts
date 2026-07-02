import { apiRequest, jsonInit } from './client';
import type { KbCreateRequest, KbFile, KbRenameRequest, KbView, KbTree } from '@shared/kb';

export interface KbBrowseResult {
  path: string;
  entries: { name: string; path: string }[];
}

export async function fetchKbs(): Promise<KbView[]> {
  const body = await apiRequest<{ kbs: KbView[] }>('/api/kbs');
  return body.kbs;
}

export async function fetchKbBrowse(path?: string): Promise<KbBrowseResult> {
  const url = path
    ? `/api/filesystem/browse?path=${encodeURIComponent(path)}`
    : '/api/filesystem/browse';
  return apiRequest(url);
}

// Create a new subdirectory under `parent` (omit to target the home root).
// Returns the refreshed browse of the parent (its absolute path + entries).
export async function createDirectory(
  name: string,
  parent?: string,
): Promise<KbBrowseResult> {
  return apiRequest(
    '/api/filesystem/mkdir',
    jsonInit('POST', parent ? { parent, name } : { name }),
  );
}

export async function addKb(kb: KbCreateRequest): Promise<KbView[]> {
  const body = await apiRequest<{ kbs: KbView[] }>('/api/kbs', jsonInit('POST', kb));
  return body.kbs;
}

export async function fetchKb(id: string): Promise<KbView> {
  return apiRequest(`/api/kbs/${encodeURIComponent(id)}`);
}

export async function renameKb(id: string, label: string): Promise<KbView[]> {
  const input: KbRenameRequest = { label };
  const body = await apiRequest<{ kbs: KbView[] }>(
    `/api/kbs/${encodeURIComponent(id)}/rename`,
    jsonInit('POST', input),
  );
  return body.kbs;
}

export async function removeKb(id: string): Promise<KbView[]> {
  const body = await apiRequest<{ kbs: KbView[] }>(
    `/api/kbs/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  return body.kbs;
}

export async function fetchKbTree(id: string): Promise<KbTree> {
  return apiRequest(`/api/kbs/${encodeURIComponent(id)}/tree`);
}

export async function fetchKbFile(id: string, filePath: string): Promise<KbFile> {
  return apiRequest(`/api/kbs/${encodeURIComponent(id)}/file?path=${encodeURIComponent(filePath)}`);
}

export function kbDownloadUrl(id: string, filePath: string): string {
  return `/api/kbs/${encodeURIComponent(id)}/download?path=${encodeURIComponent(filePath)}`;
}
