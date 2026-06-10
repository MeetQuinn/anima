import type { AgentRuntimeNotificationTarget } from '../providers/contract.js';
import { WakeQueueService, type InboxItem } from '../inbox/wake-queue.service.js';

export async function notificationTargetForAgentItem(
  agentId: string,
  itemId: string,
): Promise<AgentRuntimeNotificationTarget | undefined> {
  const item = await new WakeQueueService(agentId).find(itemId);
  if (!item) return undefined;
  return notificationTargetForInboxItem(item);
}

export function notificationTargetForInboxItem(
  item: InboxItem,
): AgentRuntimeNotificationTarget | undefined {
  if (item.kind === 'slack' || item.kind === 'onboarding') {
    return {
      channel: item.channelId,
      platform: 'slack',
      ...(item.kind === 'slack' && item.threadTs
        ? { threadTs: item.threadTs }
        : {}),
    };
  }
  if (item.kind === 'choice_response') {
    return {
      channel: item.channelId,
      platform: 'slack',
      threadTs: item.threadTs,
    };
  }
  if (item.kind === 'feishu') {
    return {
      channel: item.chatId,
      platform: 'feishu',
      ...(item.threadId ? { threadTs: item.threadId } : {}),
    };
  }
  if (item.kind === 'feishu_onboarding') {
    return {
      channel: item.target.receiveId,
      platform: 'feishu',
    };
  }
  return undefined;
}
