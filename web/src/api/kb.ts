import { apiRequest, jsonInit } from './client';
import type {
  KbCreateRequest,
  KbDirectoryPage,
  KbFile,
  KbRenameRequest,
  KbSearchResult,
  KbView,
  KbTree,
} from '@shared/kb';

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

export async function fetchKbDirectory(
  id: string,
  path: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<KbDirectoryPage> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (cursor) params.set('cursor', cursor);
  const suffix = params.size ? `?${params.toString()}` : '';
  return apiRequest(`/api/kbs/${encodeURIComponent(id)}/entries${suffix}`, { signal });
}

export async function searchKb(id: string, query: string, signal?: AbortSignal): Promise<KbSearchResult> {
  const params = new URLSearchParams({ q: query });
  return apiRequest(`/api/kbs/${encodeURIComponent(id)}/search?${params.toString()}`, { signal });
}

export async function fetchKbFile(id: string, filePath: string, signal?: AbortSignal): Promise<KbFile> {
  return apiRequest(`/api/kbs/${encodeURIComponent(id)}/file?path=${encodeURIComponent(filePath)}`, { signal });
}

export function kbDownloadUrl(id: string, filePath: string): string {
  return `/api/kbs/${encodeURIComponent(id)}/download?path=${encodeURIComponent(filePath)}`;
}
