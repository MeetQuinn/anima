import type { AgentTokenUsageReport } from '@shared/agent-token-usage';
import { apiRequest } from './client';

export interface TokenUsageRange {
  from: string;
  gridThrough: string;
  through: string;
  timezone: string;
}

export function currentTokenUsageRange(now = new Date()): TokenUsageRange {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const today = atLocalNoon(now);
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (51 * 7));
  const gridThrough = new Date(start);
  gridThrough.setDate(start.getDate() + (52 * 7) - 1);
  return {
    from: localDate(start),
    gridThrough: localDate(gridThrough),
    through: localDate(today),
    timezone,
  };
}

export async function fetchAgentTokenUsage(
  range: TokenUsageRange,
  agentId?: string,
): Promise<AgentTokenUsageReport> {
  const params = new URLSearchParams({
    from: range.from,
    through: range.through,
    timezone: range.timezone,
  });
  if (agentId) params.set('agentId', agentId);
  return apiRequest(`/api/agent-token-usage?${params.toString()}`);
}

export function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function atLocalNoon(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12);
}
