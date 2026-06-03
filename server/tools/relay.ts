import type { AgentMessageInboxItem } from '../../shared/inbox.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { resolveAgentIdFrom } from '../cli/shared.js';
import { makeId, nowIso } from '../ids.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { withToolActivity } from './tool-context.js';

export interface RelaySendInput {
  agent?: string;
  replyTo?: string;
  text: string;
  to: string;
}

export interface RelayListInput {
  agent?: string;
}

export async function runRelaySend(input: RelaySendInput): Promise<void> {
  const fromAgentId = resolveAgentIdFrom(input.agent);
  if (!fromAgentId) throw new Error('Agent not specified. Pass --agent <id> or set ANIMA_AGENT_ID.');
  const toAgentId = input.to.trim();
  if (!toAgentId) throw new Error('Missing --to <agentId>.');
  if (toAgentId === fromAgentId) throw new Error('Cannot relay a message to yourself.');

  const ids = await defaultAgentRegistryService.listAgentIds();
  if (!ids.includes(toAgentId)) {
    throw new Error(`Unknown target agent: ${toAgentId}. Run \`anima relay list\` to see reachable agents.`);
  }

  const [fromConfig, toConfig] = await Promise.all([
    defaultAgentRegistryService.serviceFor(fromAgentId).getConfig(),
    defaultAgentRegistryService.serviceFor(toAgentId).getConfig(),
  ]);
  const fromName = fromConfig.profile.displayName;
  const toName = toConfig.profile.displayName;

  const receivedAt = nowIso();
  const messageId = `agent_msg:${fromAgentId}:${toAgentId}:${makeId('m')}`;
  const item: AgentMessageInboxItem = {
    fromAgentId,
    fromName,
    handling: { createdAt: receivedAt, queuedAt: receivedAt, status: 'queued', updatedAt: receivedAt },
    id: messageId,
    kind: 'agent_message',
    receivedAt,
    text: input.text,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
  };

  await withToolActivity({
    audit: { agentId: fromAgentId },
    basePayload: {
      channel: toAgentId,
      channelKind: 'agent',
      dmHandle: toName,
      fromAgentId,
      messageId,
      text: input.text,
      toAgentId,
      toName,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    },
    effectType: 'agent.relay.send',
    op: async () => {
      const result = await new WakeQueueService(toAgentId).enqueue(item);
      return { completedPayload: { duplicate: result.duplicate, queued: result.queued }, result: undefined };
    },
  });

  console.log(`relayed successfully. to=${toAgentId} (${toName}), message_id=${messageId}.`);
}

export async function runRelayList(input: RelayListInput): Promise<void> {
  const selfId = resolveAgentIdFrom(input.agent);
  const ids = await defaultAgentRegistryService.listAgentIds();
  const targets = ids.filter((id) => id !== selfId);
  if (targets.length === 0) {
    console.log('No other local agents to relay to.');
    return;
  }
  for (const id of targets) {
    const config = await defaultAgentRegistryService.serviceFor(id).getConfig();
    const role = config.profile.role ? ` — ${config.profile.role}` : '';
    console.log(`${id} (${config.profile.displayName})${role}`);
  }
}
