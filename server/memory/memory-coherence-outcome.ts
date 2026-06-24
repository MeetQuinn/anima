import { activityServiceForAgent } from '../activities/activity.service.js';
import { truncateForActivity } from '../activities/format.js';
import { errorMessage, nowIso } from '../ids.js';
import type { MemoryCoherenceInboxItem } from '../../shared/inbox.js';
import type { Activity, MemoryCoherenceOutcome, MemoryCoherenceOutcomePayload } from '../../shared/activity.js';

export function memoryCoherenceSummary(text: string | undefined): string | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  return truncateForActivity(trimmed);
}

export function determineMemoryCoherenceOutcome(activities: Activity[]): MemoryCoherenceOutcome {
  const failedToolIds = new Set<string>();
  for (const activity of activities) {
    if (activity.type !== 'tool.call.failed') continue;
    const id = stringPayloadField(activity, 'providerToolId');
    if (id) failedToolIds.add(id);
  }
  return activities.some((activity) => isObservedEditActivity(activity, failedToolIds))
    ? 'completed'
    : 'quiet_skipped';
}

export async function recordMemoryCoherenceCompleted(input: {
  agentId: string;
  completedAt?: string;
  item: MemoryCoherenceInboxItem;
  observedActivities: Activity[];
  resultText?: string;
  startedAt: string;
}): Promise<void> {
  const payload = basePayload(input);
  const summary = memoryCoherenceSummary(input.resultText);
  await activityServiceForAgent(input.agentId).record({
    payload: {
      ...payload,
      outcome: determineMemoryCoherenceOutcome(input.observedActivities),
      ...(summary ? { summary } : {}),
    },
    type: 'memory_coherence.outcome',
  });
}

export async function recordMemoryCoherenceFailed(input: {
  agentId: string;
  completedAt?: string;
  error: unknown;
  item: MemoryCoherenceInboxItem;
  startedAt: string;
}): Promise<void> {
  await activityServiceForAgent(input.agentId).record({
    payload: {
      ...basePayload(input),
      failureReason: errorMessage(input.error),
      outcome: 'failed',
    },
    type: 'memory_coherence.outcome',
  });
}

function basePayload(input: {
  completedAt?: string;
  item: MemoryCoherenceInboxItem;
  startedAt: string;
}): Omit<MemoryCoherenceOutcomePayload, 'outcome'> {
  const completedAt = input.completedAt ?? nowIso();
  const delay = delayMs(input.startedAt, input.item.scheduledSlotAt);
  return {
    completedAt,
    ...(delay > 0 ? { delayMs: delay } : {}),
    scheduledSlotAt: input.item.scheduledSlotAt,
    scheduledSlotLabel: input.item.scheduledSlotLabel,
    startedAt: input.startedAt,
  };
}

function delayMs(startedAt: string, scheduledSlotAt: string): number {
  const start = Date.parse(startedAt);
  const scheduled = Date.parse(scheduledSlotAt);
  if (!Number.isFinite(start) || !Number.isFinite(scheduled)) return 0;
  return Math.max(0, start - scheduled);
}

function isObservedEditActivity(activity: Activity, failedToolIds: Set<string>): boolean {
  if (activity.type !== 'tool.call.started') return false;
  const id = stringPayloadField(activity, 'providerToolId');
  if (id && failedToolIds.has(id)) return false;
  const tool = stringPayloadField(activity, 'tool')?.toLowerCase() ?? '';
  const providerToolName = stringPayloadField(activity, 'providerToolName')?.toLowerCase() ?? '';
  const names = [tool, providerToolName].filter(Boolean);
  return names.some((name) => EDIT_TOOL_NAMES.has(name));
}

function stringPayloadField(activity: Activity, key: string): string | undefined {
  const value = activity.payload?.[key];
  return typeof value === 'string' ? value : undefined;
}

const EDIT_TOOL_NAMES = new Set([
  'codex.filechange',
  'edit',
  'claude.edit',
  'claude.multiedit',
  'claude.write',
  'multiedit',
  'strreplacefile',
  'write',
  'kimi.strreplacefile',
  'kimi.writefile',
]);
