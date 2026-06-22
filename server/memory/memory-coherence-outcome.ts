import { activityServiceForAgent } from '../activities/activity.service.js';
import { truncateForActivity } from '../activities/format.js';
import { errorMessage, nowIso } from '../ids.js';
import type { MemoryCoherenceInboxItem } from '../../shared/inbox.js';
import type { MemoryCoherenceOutcome, MemoryCoherenceOutcomePayload } from '../../shared/activity.js';

const COMPLETED_MARKER = 'Memory coherence outcome: completed';
const QUIET_SKIPPED_MARKER = 'Memory coherence outcome: quiet_skipped';

export function parseMemoryCoherenceOutcome(text: string | undefined): MemoryCoherenceOutcome {
  const marker = finalNonEmptyLine(text);
  if (marker === QUIET_SKIPPED_MARKER) return 'quiet_skipped';
  return 'completed';
}

export function memoryCoherenceSummary(text: string | undefined): string | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/);
  const finalLine = lines.at(-1)?.trim();
  const withoutMarker =
    finalLine === COMPLETED_MARKER || finalLine === QUIET_SKIPPED_MARKER
      ? lines.slice(0, -1).join('\n').trim()
      : trimmed;
  if (!withoutMarker) return undefined;
  return truncateForActivity(withoutMarker);
}

export async function recordMemoryCoherenceCompleted(input: {
  agentId: string;
  completedAt?: string;
  item: MemoryCoherenceInboxItem;
  resultText?: string;
  startedAt: string;
}): Promise<void> {
  const payload = basePayload(input);
  const summary = memoryCoherenceSummary(input.resultText);
  await activityServiceForAgent(input.agentId).record({
    payload: {
      ...payload,
      outcome: parseMemoryCoherenceOutcome(input.resultText),
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

function finalNonEmptyLine(text: string | undefined): string {
  return (text ?? '')
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';
}

function delayMs(startedAt: string, scheduledSlotAt: string): number {
  const start = Date.parse(startedAt);
  const scheduled = Date.parse(scheduledSlotAt);
  if (!Number.isFinite(start) || !Number.isFinite(scheduled)) return 0;
  return Math.max(0, start - scheduled);
}
