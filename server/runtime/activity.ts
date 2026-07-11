import { activityServiceForAgent } from '../activities/activity.service.js';
import { makeId, nowIso } from '../ids.js';
import { stringField } from '../json.js';
import type { Activity } from '../../shared/activity.js';
import { isRuntimeEventNoise } from '../../shared/runtime-event-noise.js';
import { truncateForActivity } from '../activities/format.js';
import { runtimeSessionServiceForAgent } from './runtime-session.service.js';
import type { ItemStopReason } from './types.js';

export interface RuntimeActivityTarget {
  agentId: string;
  itemId?: string;
}

export async function recordRuntimeActivity(
  target: RuntimeActivityTarget,
  runtimeKind: string,
  type: 'runtime.started' | 'runtime.completed' | 'runtime.failed',
  payload?: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    payload: {
      ...(target.itemId ? { itemId: target.itemId } : {}),
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
      ...(target.itemId ? { itemId: target.itemId } : {}),
      runtimeKind,
      ...payload,
    },
    type: 'runtime.event',
  } as const;
  if (shouldPersistRuntimeEvent(activityInput.payload)) {
    const activity = await activityServiceForAgent(target.agentId).record(activityInput);
    if (shouldUpdateRuntimeStats(activityInput.payload)) {
      await runtimeSessionServiceForAgent(target.agentId).updateRuntimeStats(runtimeKind, runtimeEnv, activity);
    }
    return;
  }

  const activity: Activity = {
    activityId: makeId('actv'),
    createdAt: createdAt ?? nowIso(),
    payload: activityInput.payload,
    type: 'runtime.event',
  };
  if (shouldUpdateRuntimeStats(activityInput.payload)) {
    await runtimeSessionServiceForAgent(target.agentId).updateRuntimeStats(runtimeKind, runtimeEnv, activity);
  }
}

export async function recordSessionRotationActivity(
  target: RuntimeActivityTarget,
  payload: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    type: 'anima.session.rotate',
    payload: {
      ...(target.itemId ? { itemId: target.itemId } : {}),
      ...payload,
    },
  });
}

function shouldPersistRuntimeEvent(payload: Record<string, unknown> | undefined): boolean {
  const eventType = stringField(payload, 'eventType');
  if (!eventType) return true;
  // Persist-side exception to the shared noise list: kimi context stats feed
  // runtime session stats (updateRuntimeStats), so they are kept on disk even
  // though the read side never renders them.
  if (eventType === 'kimi.context.stats') return true;
  return !isRuntimeEventNoise(eventType);
}

function shouldUpdateRuntimeStats(payload: Record<string, unknown> | undefined): boolean {
  const eventType = stringField(payload, 'eventType');
  return (
    eventType === 'claude.session.stats'
    || eventType === 'codex.session.stats'
    || eventType === 'kimi.context.stats'
    || eventType === 'claude.context.stats'
    || eventType === 'codex.context.stats'
    || eventType?.endsWith('.compact.completed') === true
  );
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
      ...(target.itemId ? { itemId: target.itemId } : {}),
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
      ...(target.itemId ? { itemId: target.itemId } : {}),
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
    payload: { ...(target.itemId ? { itemId: target.itemId } : {}), ...(payload ?? {}), reason },
    type: 'runtime.aborted',
  });
}

export async function recordRuntimeToolStarted(
  target: RuntimeActivityTarget,
  payload: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    payload: { ...(target.itemId ? { itemId: target.itemId } : {}), ...payload },
    type: 'tool.call.started',
  });
}

export async function recordRuntimeToolFailed(
  target: RuntimeActivityTarget,
  payload: Record<string, unknown>,
): Promise<void> {
  await activityServiceForAgent(target.agentId).record({
    payload: { ...(target.itemId ? { itemId: target.itemId } : {}), ...payload },
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
