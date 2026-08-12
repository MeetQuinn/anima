import type {
  SlackShortcutHandoffInput,
  SlackShortcutHandoffResult,
  SlackShortcutHandoffService,
} from '../slack-interactions/shortcut.service.js';
import type { SlackInboxItem } from '../../shared/inbox.js';
import { nowIso } from '../ids.js';
import { observeSlackWakeInJournal } from '../runtime/cursor-wake-journal-backfill.js';
import { wakeQueueServiceForAgent } from './wake-queue.service.js';

export function slackShortcutHandoffServiceForAgent(agentId: string): SlackShortcutHandoffService {
  return new SlackShortcutWakeQueueHandoffService(agentId);
}

class SlackShortcutWakeQueueHandoffService implements SlackShortcutHandoffService {
  constructor(private readonly agentId: string) {}

  async handMessageToAgent(input: SlackShortcutHandoffInput): Promise<SlackShortcutHandoffResult> {
    const item = slackShortcutInboxItem(input);
    // Journal before enqueue so cursor-delivery prepare can find the trigger
    // even for post-start shortcut wakes (not only upgrade-time backfill).
    // Fail-soft: store.observe marks continuity degraded on write failure;
    // pre-drain backfill still retries active wakes on later drains.
    await observeSlackWakeInJournal({ agentId: this.agentId, item });
    const result = await wakeQueueServiceForAgent(this.agentId).enqueue(item);
    return {
      duplicate: result.duplicate,
      itemId: result.item.id,
      queued: result.queued,
    };
  }
}

function slackShortcutInboxItem(input: SlackShortcutHandoffInput): SlackInboxItem {
  const now = nowIso();
  // Prefer source message author; fall back to shortcut invoker when Slack
  // omits message.user (legal for some source messages). Observation still
  // has a stable botId fallback if both are absent (see observeInputFromSlackWake).
  const actorUserId = input.sourceUserId?.trim() || input.invokerUserId?.trim() || undefined;
  return {
    actor: {
      ...(actorUserId ? { userId: actorUserId } : {}),
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
