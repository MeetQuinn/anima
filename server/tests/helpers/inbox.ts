import { WakeQueueService, type InboxItem } from '../../inbox/wake-queue.service.js';
import { runtimeContextForItemId } from '../../runtime/context.js';
import type { RuntimeWorkerConfig, RuntimeItemContext } from '../../runtime/types.js';
import type { ReminderInboxItem } from '../../../shared/inbox.js';

export async function ingestEvent(event: InboxItem, config: RuntimeWorkerConfig): Promise<RuntimeItemContext> {
  const result = await new WakeQueueService(config.agentId).enqueue(event);
  return runtimeContextForItemId(result.item.id, config);
}

export function makeReminderInboxItem(opts: {
  eventId?: string;
  reminderId: string;
  timestamp?: string;
}): ReminderInboxItem {
  const receivedAt = opts.timestamp ?? new Date().toISOString();
  return {
    id: opts.eventId ?? `evt_reminder_${opts.reminderId}`,
    kind: 'reminder',
    receivedAt,
    handling: {
      createdAt: receivedAt,
      queuedAt: receivedAt,
      status: 'queued',
      updatedAt: receivedAt,
    },
    reminderId: opts.reminderId,
  };
}
