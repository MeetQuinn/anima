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

// No logout counterpart on purpose. The dashboard is machine-local, so the
// security boundary is the machine and not the browser session: closing the tab
// or stopping the server is the logout (iris, `1786086839.466209`). If remote
// access ever lands, logout becomes a real requirement and gets designed from
// the threat model up rather than resurrected from a stub.
