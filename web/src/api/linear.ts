import type { LinearSetup, LinearSetupRequest } from '@shared/linear-setup';
import type { LinearInstallRequest, LinearStatus } from '@shared/linear';
import { apiRequest, jsonInit } from './client';

export const fetchLinearStatus = (id: string): Promise<LinearStatus> => apiRequest(`/api/agents/${encodeURIComponent(id)}/linear`);
export const installLinear = (id: string, input: LinearInstallRequest): Promise<{ authorizationUrl: string }> =>
  apiRequest(`/api/agents/${encodeURIComponent(id)}/linear/install`, jsonInit('POST', input));
export const removeLinear = (id: string): Promise<{ removed: boolean }> => apiRequest(`/api/agents/${encodeURIComponent(id)}/linear`, { method: 'DELETE' });

export const fetchLinearSetup = (): Promise<LinearSetup> => apiRequest('/api/linear/setup');
export const saveLinearSetup = (input: LinearSetupRequest): Promise<LinearSetup> =>
  apiRequest('/api/linear/setup', jsonInit('PUT', input));
