import type {
  SlackShortcutHandoffInput,
  SlackShortcutHandoffResult,
  SlackShortcutHandoffService,
} from '../slack-interactions/shortcut.service.js';
import { nowIso } from '../ids.js';
import { wakeQueueServiceForAgent, type InboxItem } from './wake-queue.service.js';

export function slackShortcutHandoffServiceForAgent(agentId: string): SlackShortcutHandoffService {
  return new SlackShortcutWakeQueueHandoffService(agentId);
}

class SlackShortcutWakeQueueHandoffService implements SlackShortcutHandoffService {
  constructor(private readonly agentId: string) {}

  async handMessageToAgent(input: SlackShortcutHandoffInput): Promise<SlackShortcutHandoffResult> {
    const item = slackShortcutInboxItem(input);
    const result = await wakeQueueServiceForAgent(this.agentId).enqueue(item);
    return {
      duplicate: result.duplicate,
      itemId: result.item.id,
      queued: result.queued,
    };
  }
}

function slackShortcutInboxItem(input: SlackShortcutHandoffInput): InboxItem {
  const now = nowIso();
  return {
    actor: {
      ...(input.sourceUserId ? { userId: input.sourceUserId } : {}),
    },
    channelId: input.channelId,
    ...(input.channelName ? { channelName: input.channelName } : {}),
    handling: { createdAt: now, queuedAt: now, status: 'queued', updatedAt: now },
    id: `slack-shortcut-handoff:${input.teamId}:${input.channelId}:${input.messageTs}`,
    kind: 'slack',
    messageTs: input.messageTs,
    receivedAt: input.receivedAt,
    teamId: input.teamId,
    text: input.text,
    threadTs: input.threadTs,
  };
}
