import { apiRequest, jsonInit } from './client';
import type { ProviderAvailability } from '@shared/provider-catalog';
import type { ProviderUsageResponse } from '@shared/provider-usage';
import type { ServerInfo } from '@shared/server-info';
import type { SidebarOrder } from '@shared/server-settings';
import type {
  RuntimeUpgradeApplyResponse,
  RuntimeUpgradeStatusResponse,
} from '@shared/runtime-upgrade';

export type { SidebarOrder } from '@shared/server-settings';

// ---------------------------------------------------------------------------
// Sidebar order
// ---------------------------------------------------------------------------

export async function fetchSidebarOrder(): Promise<SidebarOrder> {
  const body = await apiRequest<{ sidebarOrder: SidebarOrder }>('/api/sidebar-order');
  return body.sidebarOrder;
}

export async function saveSidebarOrder(order: SidebarOrder): Promise<SidebarOrder> {
  const body = await apiRequest<{ sidebarOrder: SidebarOrder }>(
    '/api/sidebar-order',
    jsonInit('PUT', order),
  );
  return body.sidebarOrder;
}

export async function fetchProviderAvailability(): Promise<ProviderAvailability[]> {
  const body = await apiRequest<{ providers: ProviderAvailability[] }>('/api/provider-availability');
  return body.providers;
}

export async function fetchProviderUsage(): Promise<ProviderUsageResponse> {
  return apiRequest('/api/provider-usage');
}

export async function fetchServerInfo(): Promise<ServerInfo> {
  return apiRequest('/api/server-info');
}

interface RestartServicesResult {
  animaHome: string;
  delayMs: number;
  logPath: string;
  ok: true;
  scheduled: true;
}

export async function restartServices(): Promise<RestartServicesResult> {
  return apiRequest('/api/services/restart', jsonInit('POST'));
}

export async function pingHealth(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// System update (managed runtime upgrade)
// External route is /api/system-update; the shared types keep the internal
// `RuntimeUpgrade*` names per the backend contract.
// ---------------------------------------------------------------------------

export async function fetchRuntimeUpgrade(): Promise<RuntimeUpgradeStatusResponse> {
  return apiRequest('/api/system-update');
}

export async function checkRuntimeUpgrade(): Promise<RuntimeUpgradeStatusResponse> {
  return apiRequest('/api/system-update/check', jsonInit('POST'));
}

/**
 * Apply errors carry the HTTP status so the UI can distinguish the gate race
 * (409 — an agent started working between status and click) and unavailable
 * (503) from generic failures, without re-deriving from the message string.
 */
export class RuntimeUpgradeApplyError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'RuntimeUpgradeApplyError';
    this.status = status;
  }
}

export async function applyRuntimeUpgrade(): Promise<RuntimeUpgradeApplyResponse> {
  const res = await fetch('/api/system-update/apply', { cache: 'no-store', ...jsonInit('POST') });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const message =
      typeof body === 'object' && body !== null && 'error' in body &&
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    throw new RuntimeUpgradeApplyError(message, res.status);
  }
  return res.json() as Promise<RuntimeUpgradeApplyResponse>;
}
