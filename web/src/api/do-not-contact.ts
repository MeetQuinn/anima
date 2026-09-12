import type { ContactDirectory, ContactWorkspace } from '@shared/do-not-contact';
import { apiRequest, jsonInit } from './client';

export async function fetchContactWorkspaces(): Promise<ContactWorkspace[]> {
  const result = await apiRequest<{ workspaces: ContactWorkspace[] }>('/api/do-not-contact');
  return result.workspaces;
}

export function fetchContactDirectory(workspaceId: string): Promise<ContactDirectory> {
  return apiRequest(`/api/do-not-contact/${encodeURIComponent(workspaceId)}/users`);
}

export function changeContactMember(workspaceId: string, userId: string, action: 'add' | 'remove'): Promise<{ ok: true }> {
  return apiRequest(`/api/do-not-contact/${encodeURIComponent(workspaceId)}/members`, jsonInit(action === 'add' ? 'POST' : 'DELETE', { userId }));
}
