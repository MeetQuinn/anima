import { activityServiceForAgent } from '../activities/activity.service.js';
import { makeId, nowIso } from '../ids.js';
import { stringField } from '../json.js';
import type { Activity } from '../../shared/activity.js';
import { truncateForActivity } from '../activities/format.js';
import { runtimeSessionServiceForAgent } from './runtime-session.service.js';
import type { ItemStopReason } from './types.js';

export interface RuntimeActivityTarget {
  agentId: string;
}

export async function recordRuntimeActivity(
  target: RuntimeActivityTarget,
  runtimeKind: string,
  type: 'runtime.started' | 'runtime.completed' | 'runtime.failed',
  payload?: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    payload: {
      runtimeKind,
      ...(payload ?? {}),
    },
    type,
  });
}

export async function recordRuntimeEvent(
  target: RuntimeActivityTarget,
  runtimeKind: string,
  runtimeEnv: Record<string, string> | undefined,
  payload: Record<string, unknown>,
  createdAt?: string,
): Promise<void> {
  const activityInput = {
    ...(createdAt ? { createdAt } : {}),
    payload: {
      runtimeKind,
      ...payload,
    },
    type: 'runtime.event',
  } as const;
  if (shouldPersistRuntimeEvent(activityInput.payload)) {
    const activity = await activityServiceForAgent(target.agentId).record(activityInput);
    await runtimeSessionServiceForAgent(target.agentId).updateRuntimeStats(runtimeKind, runtimeEnv, activity);
    return;
  }

  const activity: Activity = {
    activityId: makeId('actv'),
    createdAt: createdAt ?? nowIso(),
    payload: activityInput.payload,
    type: 'runtime.event',
  };
  await runtimeSessionServiceForAgent(target.agentId).updateRuntimeStats(runtimeKind, runtimeEnv, activity);
}

function shouldPersistRuntimeEvent(payload: Record<string, unknown> | undefined): boolean {
  const eventType = stringField(payload, 'eventType');
  if (!eventType) return true;
  if (eventType === 'provider.reasoning') return false;
  if (eventType.endsWith('.context.stats') && eventType !== 'kimi.context.stats') return false;
  if (eventType.endsWith('.system.init')) return false;
  if (eventType.includes('.stream.')) return false;
  if (eventType.includes('.reasoning.')) return false;
  if (eventType.endsWith('.thinking.delta')) return false;
  if (eventType.endsWith('.content.part')) return false;
  if (eventType.endsWith('.tool.call.part')) return false;
  if (eventType.endsWith('.tool_result')) return false;
  if (eventType.endsWith('.hook.triggered') || eventType.endsWith('.hook.resolved')) return false;
  if (eventType.endsWith('.plan.display') || eventType.endsWith('.plan.updated')) return false;
  if (eventType.endsWith('.diff.updated')) return false;
  if (eventType.endsWith('.subagent.event')) return false;
  if (eventType.endsWith('.mcp.progress')) return false;
  if (eventType.endsWith('.raw_response_item.completed')) return false;
  if (eventType.endsWith('.steer.consumed')) return false;
  if (eventType.endsWith('.turn.started') || eventType.endsWith('.turn.completed')) return false;
  if (eventType.endsWith('.step.started')) return false;
  if (eventType.includes('.outputDelta')) return false;
  if (eventType.includes('.patchUpdated')) return false;
  return true;
}

export async function recordRuntimeOutputChunk(
  target: RuntimeActivityTarget,
  runtimeKind: string,
  stream: 'stderr' | 'stdout',
  text: string,
): Promise<void> {
  if (!text.trim()) return;
  await activityServiceForAgent(target.agentId).record({
    payload: {
      runtimeKind,
      stream,
      text: truncateForActivity(text),
    },
    type: 'runtime.output',
  });
}

export async function recordAgentText(
  target: RuntimeActivityTarget,
  runtimeKind: string,
  text: string | undefined,
  payload?: Record<string, unknown>,
): Promise<void> {
  if (!text?.trim()) return;
  await activityServiceForAgent(target.agentId).record({
    payload: {
      ...(payload ?? {}),
      runtimeKind,
      text: truncateForActivity(text),
    },
    type: 'agent.text',
  });
}

export async function recordRuntimeAborted(
  target: RuntimeActivityTarget,
  reason: ItemStopReason,
  payload?: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    payload: { ...(payload ?? {}), reason },
    type: 'runtime.aborted',
  });
}

export async function recordRuntimeToolStarted(
  target: RuntimeActivityTarget,
  payload: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    payload,
    type: 'tool.call.started',
  });
}

export async function recordRuntimeToolFailed(
  target: RuntimeActivityTarget,
  payload: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    payload,
    type: 'tool.call.failed',
  });
}

export async function recordRuntimeFollowupAppended(
  target: RuntimeActivityTarget,
  payload: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    payload,
    type: 'runtime.followup_appended',
  });
}

export async function recordRuntimePending(
  target: RuntimeActivityTarget,
  payload: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    payload,
    type: 'runtime.pending',
  });
}

export async function recordRuntimeFollowupFailed(
  target: RuntimeActivityTarget,
  payload: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    payload,
    type: 'runtime.followup_failed',
  });
}
