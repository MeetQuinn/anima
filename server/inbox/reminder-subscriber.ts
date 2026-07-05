import { errorMessage } from '../ids.js';
import { reminderServiceForAgent, type ReminderService } from '../reminders/reminder.service.js';
import type { Reminder } from '../../shared/reminder.js';
import type { ReminderInboxItem } from '../../shared/inbox.js';
import { WakeQueueService } from './wake-queue.service.js';

const REMINDER_POLL_MS = 30_000;

export class ReminderInboxSubscriber {
  private poll?: Promise<void>;
  private readonly reminderService: ReminderService;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly queue: WakeQueueService,
    reminderService?: ReminderService,
  ) {
    this.reminderService = reminderService ?? reminderServiceForAgent(queue.agentId);
  }

  start(): void {
    this.timer = setInterval(() => void this.pollDueReminders(), REMINDER_POLL_MS);
    this.timer.unref();
    void this.pollDueReminders();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await (this.poll ?? Promise.resolve());
  }

  private async pollDueReminders(): Promise<void> {
    if (this.poll) return this.poll;
    this.poll = this.fireDueReminders()
      .catch((error: unknown) => {
        console.error(`Reminder scheduler failed for ${this.queue.agentId}: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.poll = undefined;
      });
    return this.poll;
  }

  private async fireDueReminders(): Promise<void> {
    const firedAt = new Date();
    for (const reminder of await this.reminderService.dueReminders({ now: firedAt })) {
      await this.fireReminder(reminder, firedAt);
    }
  }

  private async fireReminder(reminder: Reminder, firedAt: Date): Promise<void> {
    const receivedAt = firedAt.toISOString();
    const event: ReminderInboxItem = {
      id: `reminder:${reminder.reminderId}:fire:${reminder.firedCount + 1}`,
      kind: 'reminder',
      receivedAt,
      handling: {
        createdAt: receivedAt,
        queuedAt: receivedAt,
        status: 'queued',
        updatedAt: receivedAt,
      },
      reminderId: reminder.reminderId,
      ...(reminder.nextDueAt ? { scheduledAt: reminder.nextDueAt } : {}),
      title: reminder.title,
    };
    const decision = await this.queue.enqueue(event);
    const firedReminder = await this.reminderService.completeReminderFire({
      id: reminder.reminderId,
      now: firedAt,
    });
    if (!decision.duplicate) {
      await this.reminderService.recordReminderFire({
        firedAt,
        reminder: firedReminder,
      });
    }
    console.log(
      `reminder fired reminderId=${reminder.reminderId} eventId=${event.id} duplicate=${Boolean(decision.duplicate)} queued=${Boolean(decision.queued)} firedAt=${firedAt.toISOString()}`,
    );
  }
}
