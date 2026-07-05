import type { FeishuReceiveIdType } from '../feishu/client.js';
import type { FeishuInboxItem, InboxItem } from '../../shared/inbox.js';

export type ResolvedChatTarget =
  | { platform: 'slack' }
  | {
      displayName?: string;
      platform: 'feishu';
      receiveId: string;
      receiveIdType: FeishuReceiveIdType;
      surfaceKind?: string;
    };

export function resolveChatTarget(channel: string | undefined, item?: InboxItem): ResolvedChatTarget {
  if (channel?.startsWith('oc_')) {
    const feishuItem = item?.kind === 'feishu' && item.chatId === channel ? item : undefined;
    return {
      displayName: feishuItem ? feishuChatDisplayName(feishuItem) : 'Feishu chat',
      platform: 'feishu',
      receiveId: channel,
      receiveIdType: 'chat_id',
      ...(feishuItem?.chatType ? { surfaceKind: feishuItem.chatType } : {}),
    };
  }
  if (channel?.startsWith('ou_')) {
    return {
      displayName: 'Feishu owner',
      platform: 'feishu',
      receiveId: channel,
      receiveIdType: 'open_id',
      surfaceKind: 'open_id',
    };
  }
  return { platform: 'slack' };
}

function feishuChatDisplayName(item: FeishuInboxItem): string {
  if (item.chatName) return item.chatName;
  return item.chatType === 'p2p' ? 'Feishu DM' : `Feishu ${item.chatType}`;
}
