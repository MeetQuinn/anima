import type { WebClient } from '@slack/web-api';

import type { AgentConfig } from '../../shared/agent-config.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { resolveAgentIdFrom } from '../cli/shared.js';
import { errorMessage } from '../ids.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { findToolAuditRuntimeItem } from '../runtime/active-item.js';

export interface ToolActivityAudit {
  agentId: string;
}

export async function withToolActivity<T>(input: {
  audit?: ToolActivityAudit;
  basePayload: Record<string, unknown>;
  effectType?: string;
  op: () => Promise<{ result: T; completedPayload?: Record<string, unknown> }>;
}): Promise<T> {
  const startedType = input.effectType ? 'external.effect.started' : 'tool.call.started';
  const completedType = input.effectType ? 'external.effect.completed' : 'tool.call.completed';
  const failedType = input.effectType ? 'external.effect.failed' : 'tool.call.failed';
  const payload = (status: 'completed' | 'failed' | 'started', extra?: Record<string, unknown>) => ({
    ...input.basePayload,
    ...(input.effectType ? { effect: input.effectType } : {}),
    status,
    ...(extra ?? {}),
  });
  if (input.audit) {
    await activityServiceForAgent(input.audit.agentId).record({ payload: payload('started'), type: startedType });
  }
  try {
    const { result, completedPayload } = await input.op();
    if (input.audit) {
      const activity = await activityServiceForAgent(input.audit.agentId).record({
        payload: payload('completed', completedPayload),
        type: completedType,
      });
      try {
        await messageServiceForAgent(input.audit.agentId).recordOutboxActivity(activity);
      } catch (error) {
        console.warn(`Tool message ledger write failed for activity ${activity.activityId}: ${errorMessage(error)}`);
      }
    }
    return result;
  } catch (error) {
    if (input.audit) {
      await activityServiceForAgent(input.audit.agentId).record({
        payload: payload('failed', { error: errorMessage(error) }),
        type: failedType,
      });
    }
    throw error;
  }
}

export function resolveToolAgentId(opts: { agent?: string }): string | undefined {
  return resolveAgentIdFrom(opts.agent);
}

export async function resolveToolItemId(opts: { agent?: string; item?: string }): Promise<string | undefined> {
  const explicit = opts.item?.trim() || undefined;
  if (explicit) return explicit;
  const envItemId = process.env.ANIMA_INBOX_ITEM_ID?.trim() || undefined;
  const agentId = resolveAgentIdFrom(opts.agent);
  if (!agentId) return envItemId;
  const current = await findToolAuditRuntimeItem(agentId);
  if (current && !current.settledAt && current.itemId !== envItemId) return current.itemId;
  return envItemId ?? current?.itemId;
}

export async function loadAgentFromOpts(opts: object): Promise<AgentConfig> {
  const rawAgent = 'agent' in opts && typeof opts.agent === 'string' ? opts.agent : undefined;
  const id = resolveAgentIdFrom(rawAgent);
  if (!id) throw new Error('Agent not specified. Pass --agent <id> or set ANIMA_AGENT_ID.');
  return defaultAgentRegistryService.serviceFor(id).getConfig();
}

export async function slackWebClientForOpts(opts: object): Promise<{
  agent: AgentConfig;
  client: WebClient;
}> {
  const rawAgent = 'agent' in opts && typeof opts.agent === 'string' ? opts.agent : undefined;
  const id = resolveAgentIdFrom(rawAgent);
  if (!id) throw new Error('Agent not specified. Pass --agent <id> or set ANIMA_AGENT_ID.');
  return agentSlackServiceForAgent(id).getAgentWebClient();
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8').trimEnd();
}
