import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { defaultAgentRegistryService } from '../../agents/agent.service.js';
import type { Activity, AgentActivityFeedPage } from '../../../shared/activity.js';

export const agentService = (agentId: string) => defaultAgentRegistryService.serviceFor(agentId);

export function testRuntime() {
  return { kind: 'codex-cli', model: 'gpt-5.5', reasoningEffort: 'medium' };
}

export async function writeActivityJsonl(path: string, activities: Activity[]): Promise<void> {
  await writeFile(path, `${activities.map((activity) => JSON.stringify(activity)).join('\n')}\n`, 'utf8');
}

export function webApiTestActivity(activityId: string, createdAt: string): Activity {
  return {
    activityId,
    createdAt,
    type: 'runtime.completed',
  };
}

export function activityFeedReferencePages(activities: Activity[], limit: number): AgentActivityFeedPage[] {
  const pages: AgentActivityFeedPage[] = [];
  let cursor: string | undefined;
  do {
    const before = cursor;
    const events = (before ? activities.filter((activity) => activity.createdAt < before) : activities).slice(-limit);
    const nextCursor = events.length >= limit ? (events[0]?.createdAt ?? null) : null;
    pages.push({ events, nextCursor });
    cursor = nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

export function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

export async function assertStatus(response: Response, expected: number, label: string): Promise<void> {
  if (response.status === expected) return;
  const body = await response.clone().text().catch((error: unknown) => `failed to read body: ${String(error)}`);
  assert.equal(response.status, expected, `${label} returned ${response.status}: ${body}`);
}
