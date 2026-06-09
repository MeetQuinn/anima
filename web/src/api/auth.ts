import { apiRequest, jsonInit } from './client';

export interface DashboardAuthSession {
  authenticated: boolean;
  enabled: boolean;
  sessionTtlHours: number;
}

export function fetchDashboardAuthSession(): Promise<DashboardAuthSession> {
  return apiRequest<DashboardAuthSession>('/api/auth/session');
}

export function loginDashboard(password: string): Promise<{ authenticated: boolean; enabled: boolean }> {
  return apiRequest('/api/auth/login', jsonInit('POST', { password }));
}

export function logoutDashboard(): Promise<{ ok: boolean }> {
  return apiRequest('/api/auth/logout', jsonInit('POST'));
}
