import type { AttentionSuggestionPayload } from '../../shared/activity.js';
import type { FeishuInboxItem, SlackInboxItem } from '../../shared/inbox.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { errorMessage } from '../ids.js';

export function slackAttentionSuggestionPayload(
  item: SlackInboxItem,
  suggestion: string,
): AttentionSuggestionPayload {
  return {
    channelId: item.channelId,
    ...(item.channelName ? { channelName: item.channelName } : {}),
    platform: 'slack',
    suggestion,
    ...(item.threadTs ? { threadTs: item.threadTs } : {}),
  };
}

export function feishuAttentionSuggestionPayload(
  item: FeishuInboxItem,
  suggestion: string,
): AttentionSuggestionPayload {
  return {
    channelId: item.chatId,
    ...(item.chatName ? { channelName: item.chatName } : {}),
    channelKind: item.chatType,
    platform: 'feishu',
    suggestion,
    ...(item.threadId ? { threadTs: item.threadId } : {}),
  };
}

export async function recordAttentionSuggestionActivity(
  agentId: string,
  payload: AttentionSuggestionPayload,
): Promise<void> {
  try {
    await activityServiceForAgent(agentId).record({
      type: 'anima.attention.suggestion',
      payload: { ...payload },
    });
  } catch (error) {
    console.warn(`attention.suggestion activity: ${errorMessage(error)}`);
  }
}
