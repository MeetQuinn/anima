import type { BackgroundInterruptedInboxItem } from '../../shared/inbox.js';
import type { AgentRuntimeHandleSnapshot, AgentRuntimeHealthSummary } from '../../shared/snapshot.js';

export type BackgroundInterruptedCause = BackgroundInterruptedInboxItem['cause'];

export interface InterruptedBackgroundWork {
  backgroundTaskCount?: number;
  lastObservedAt: string;
  processId?: number;
  providerState: 'background' | 'working';
  taskIds: string[];
  taskIdsTruncated: boolean;
}

/**
 * Provider work a restart would orphan. An active Anima item is excluded unless
 * background tasks are also listed: interrupted active items already resume with
 * the runtime_restart continuation note.
 */
export function interruptedBackgroundWork(
  runtime: AgentRuntimeHandleSnapshot | undefined,
  lastObservedAt: string,
): InterruptedBackgroundWork | undefined {
  const work = runtime?.providerWork;
  if (!work) return undefined;
  const backgroundTaskCount = work.backgroundTaskCount ?? 0;
  if (backgroundTaskCount === 0 && (work.state !== 'background' && runtime.activeItemId)) return undefined;
  const ambient = new Set(work.backgroundEvidence?.ambientTaskIds ?? []);
  const listed = (work.backgroundEvidence?.listedTaskIds ?? []).filter((taskId) => !ambient.has(taskId));
  return {
    ...(backgroundTaskCount > 0 ? { backgroundTaskCount } : {}),
    lastObservedAt,
    ...(runtime.processId ? { processId: runtime.processId } : {}),
    providerState: work.state,
    taskIds: listed.slice(0, 32),
    taskIdsTruncated: listed.length > 32 || work.backgroundEvidence?.listedTaskIdsTruncated === true,
  };
}

/** Boot-time check: work recorded by a previous server process did not survive it. */
export function bootInterruptedBackgroundWork(
  previous: AgentRuntimeHealthSummary | undefined,
  currentProcessId: number,
): InterruptedBackgroundWork | undefined {
  const runtime = previous?.runtime;
  if (!previous || !runtime?.processId || runtime.processId === currentProcessId) return undefined;
  return interruptedBackgroundWork(runtime, previous.updatedAt);
}

export function backgroundInterruptedInboxItem(input: {
  agentId: string;
  cause: BackgroundInterruptedCause;
  /** Stable per interruption so a repeated boot or retried restart cannot enqueue twice. */
  interruptionKey: string;
  now: string;
  work: InterruptedBackgroundWork;
}): BackgroundInterruptedInboxItem {
  return {
    ...(input.work.backgroundTaskCount ? { backgroundTaskCount: input.work.backgroundTaskCount } : {}),
    cause: input.cause,
    handling: {
      createdAt: input.now,
      queuedAt: input.now,
      status: 'queued',
      updatedAt: input.now,
    },
    id: `background-interrupted:${input.agentId}:${input.interruptionKey}`,
    kind: 'background_interrupted',
    lastObservedAt: input.work.lastObservedAt,
    providerState: input.work.providerState,
    receivedAt: input.now,
    ...(input.work.taskIds.length > 0 ? { taskIds: input.work.taskIds } : {}),
    ...(input.work.taskIdsTruncated ? { taskIdsTruncated: true } : {}),
  };
}

export const BACKGROUND_INTERRUPTED_NOTE = [
  'That work was stopped together with the old provider process, so it will not report back or wake you on its own.',
  'Reconcile it now: check the native session history, task output and files to see what each background subagent or task finished.',
  'Collect completed work. Re-run or reassign only unfinished work that is still authorized, and respect cancellations and current ownership.',
  'If someone is waiting on that result, tell them where it stands. Check `anima outbox` before re-sending anything, and do not repeat completed external side effects.',
  'If nothing was pending or it had already finished, take no further action.',
].join('\n');

export function buildBackgroundInterruptedDeliveryPrompt(item: BackgroundInterruptedInboxItem): string {
  const restart = item.cause === 'server_restart' ? 'the Anima runtime restarted' : 'an operator restarted this agent';
  const work = item.backgroundTaskCount
    ? `${item.backgroundTaskCount} background task(s)`
    : 'a provider turn running outside any Anima item';
  const tasks = item.taskIds?.length
    ? `Task IDs: ${item.taskIds.join(', ')}${item.taskIdsTruncated ? ' (truncated)' : ''}.`
    : '';
  return [
    'Background work interrupted:',
    `[item=${item.id} time=${item.receivedAt} cause=${item.cause}]`,
    [
      `Anima note: ${restart} while your provider still had ${work} (last observed ${item.lastObservedAt}).`,
      tasks,
    ].filter(Boolean).join(' '),
    BACKGROUND_INTERRUPTED_NOTE,
  ].join('\n\n');
}
