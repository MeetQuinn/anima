import type { Activity } from '../../shared/activity.js';
import { stringField } from '../json.js';

export interface RestartSubtaskObservation {
  parentToolCallId: string;
  subRunId?: string;
  name?: string;
  role?: string;
  target?: string;
  lastObservedAt: string;
}

/** Durable observations, not a registry of which native children are alive. */
export function restartSubtaskObservations(
  activities: Activity[],
  providerKind: string,
  itemId: string,
): RestartSubtaskObservation[] {
  const observations = new Map<string, RestartSubtaskObservation>();
  const targets = new Map<string, string>();
  for (const activity of activities) {
    const payload = activity.payload;
    if (!payload || (payload['runtimeKind'] ?? payload['provider']) !== providerKind) continue;
    const taggedItemId = payload['itemId'] ?? payload['activeItemId'];
    if (taggedItemId && taggedItemId !== itemId) continue;
    const name = stringField(payload, 'providerToolName')?.toLowerCase();
    const spawn = activity.type === 'tool.call.started' && (name === 'agent' || name === 'task')
      && !stringField(payload, 'parentToolCallId');
    const parentToolCallId = stringField(payload, 'parentToolCallId')
      ?? (spawn ? stringField(payload, 'providerToolId') : undefined);
    if (!parentToolCallId) continue;
    const subRunId = stringField(payload, 'subRunId');
    if (!spawn && !subRunId) continue;
    const target = spawn ? stringField(payload, 'target') : undefined;
    if (target) targets.set(parentToolCallId, target.slice(0, 240));
    // A parent call can return multiple children. Keep each child, and replace
    // the unresolved spawn row once linkage arrives.
    const unresolvedKey = `${parentToolCallId}:`;
    const key = `${parentToolCallId}:${subRunId ?? ''}`;
    const previous = observations.get(key) ?? observations.get(unresolvedKey);
    const observation: RestartSubtaskObservation = {
      ...previous,
      parentToolCallId,
      lastObservedAt: activity.createdAt,
    };
    if (subRunId) {
      observation.subRunId = subRunId;
      observations.delete(unresolvedKey);
    }
    for (const field of ['name', 'role'] as const) {
      const value = stringField(payload, field);
      if (value) observation[field] = value.slice(0, 240);
    }
    observations.set(key, observation);
  }
  const linkedParents = new Set([...observations.values()]
    .filter((observation) => observation.subRunId).map((observation) => observation.parentToolCallId));
  return [...observations.values()]
    .filter((observation) => observation.subRunId || !linkedParents.has(observation.parentToolCallId))
    .map((observation) => {
      const target = targets.get(observation.parentToolCallId);
      if (target) observation.target = target;
      return observation;
    })
    .sort((a, b) => a.lastObservedAt.localeCompare(b.lastObservedAt));
}

export function restartSubtaskPrompt(observations: RestartSubtaskObservation[]): string {
  if (observations.length === 0) return '';
  const shown = observations.slice(-32);
  return [
    'Subagent observations from this interrupted task (historical, not current status):',
    ...shown.map((observation) => JSON.stringify(observation)),
    observations.length > shown.length
      ? `${observations.length - shown.length} older references omitted; consult the activity and native session history.`
      : '',
    'These references may include completed tasks. Missing IDs do not mean no subagent was started; check the native session history for unlisted work.',
  ].filter(Boolean).join('\n');
}
