import type { LinearSetup } from '@shared/linear-setup';
import type { LinearClientSecretRequest, LinearClientSecretResult, LinearInstallRequest, LinearStatus } from '@shared/linear';
import { apiRequest, jsonInit } from './client';

export const fetchLinearStatus = (id: string): Promise<LinearStatus> => apiRequest(`/api/agents/${encodeURIComponent(id)}/linear`);
export const installLinear = (id: string, input: LinearInstallRequest): Promise<{ authorizationUrl: string }> =>
  apiRequest(`/api/agents/${encodeURIComponent(id)}/linear/install`, jsonInit('POST', input));
/** Proves the secret with Linear and stores it with the refreshed tokens; the result says which. */
export const saveLinearClientSecret = (id: string, input: LinearClientSecretRequest): Promise<{ result: LinearClientSecretResult }> =>
  apiRequest(`/api/agents/${encodeURIComponent(id)}/linear/client-secret`, jsonInit('POST', input));
export const removeLinear = (id: string): Promise<{ removed: boolean }> => apiRequest(`/api/agents/${encodeURIComponent(id)}/linear`, { method: 'DELETE' });

/** Leave for Linear's authorization page in this tab; Anima's completion page brings the user back. */
export const openLinearAuthorization = (url: string): void => window.location.assign(url);

export const linearSetupKey = ['linear', 'setup'] as const;
export const fetchLinearSetup = (): Promise<LinearSetup> => apiRequest('/api/linear/setup');
