import assert from 'node:assert/strict';
import { AgentRuntimeBridge } from '../../runtime/runtime-bridge.js';
import type { AgentRuntime } from '../../providers/contract.js';
import type { RuntimeItemContext } from '../../runtime/types.js';
import type { TestState } from './state.js';
import { ReminderStore } from '../../storage/schema/reminder.store.js';
import { activitiesForInboxItemWindow } from '../../runtime/item-activities.js';

export async function runtimeInput(runtime: AgentRuntime, context: RuntimeItemContext, state?: TestState) {
  return new AgentRuntimeBridge(runtime).runInput({
    context,
    profile: { displayName: 'Anima', transports: { feishu: false, slack: true } },
    session: state?.sessions[context.agentId],
  });
}

export async function runtimeFollowupInput(
  runtime: AgentRuntime,
  activeContext: RuntimeItemContext,
  context: RuntimeItemContext,
  _state?: unknown,
) {
  return new AgentRuntimeBridge(runtime).followupInput({ activeContext, context });
}

export async function seedReminder(agentId: string, input: { instructions: string; reminderId: string; title: string }): Promise<void> {
  const now = '2026-05-18T16:00:00.000Z';
  await new ReminderStore(agentId).create({
    createdAt: now,
    firedCount: 1,
    instructions: input.instructions,
    lastFiredAt: now,
    reminderId: input.reminderId,
    schedule: { kind: 'daily', repeatRule: 'FREQ=DAILY', time: '01:30', timezone: 'UTC' },
    status: 'scheduled',
    title: input.title,
    updatedAt: now,
  });
}

export function assertFollowupPrompt(prompt: string, expectedBody: string): void {
  assert.match(prompt, /New Slack message:/);
  assert.match(prompt, /\[channel=[^\]]+ message_ts=[^\]]+\]/);
  assert.ok(prompt.includes(expectedBody));
}

export async function providerSessionStartedPayload(turnId: string): Promise<Record<string, unknown> | undefined> {
  const payload = (await activitiesForInboxItemWindow('anima', turnId)).find((activity) => activity.type === 'runtime.started')
    ?.payload?.['providerSession'];
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
}

export function runtimeTestEnv(binDir: string, env: Record<string, string> = {}): Record<string, string> {
  return {
    ...env,
    PATH: [binDir, process.env.PATH ?? ''].filter(Boolean).join(':'),
  };
}
