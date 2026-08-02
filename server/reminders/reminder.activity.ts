import { errorMessage } from '../ids.js';
import { defaultActivityRecorder, type ActivityRecorder } from '../activities/activity.service.js';
import type { Reminder } from '../../shared/reminder.js';
import {
  reminderActivityFields,
  reminderActivityPayload,
} from './reminder.helper.js';

interface ScheduleReminderActivityInput {
  agentId: string;
  delaySeconds?: number;
  fireAt?: string;
  repeat?: string;
  title: string;
  window?: string;
}

interface ReminderIdActivityInput {
  agentId: string;
  id: string;
}

export class ReminderActivityRecorder {
  constructor(private readonly activity: ActivityRecorder = defaultActivityRecorder) {}

  async schedule(
    input: ScheduleReminderActivityInput,
    op: () => Promise<Reminder>,
  ): Promise<Reminder> {
    return this.recordReminderTool({
      agentId: input.agentId,
      op,
      startedPayload: {
        title: input.title,
        ...(input.repeat ? { repeat: input.repeat } : {}),
        ...(input.window ? { window: input.window } : {}),
        ...(input.fireAt ? { fireAt: input.fireAt } : {}),
        ...(input.delaySeconds !== undefined ? { delaySeconds: input.delaySeconds } : {}),
      },
      successPayload: (reminder) => ({
        nextDueAt: reminder.nextDueAt,
        reminderId: reminder.reminderId,
        schedule: reminder.schedule,
        status: reminder.status,
        title: reminder.title,
      }),
      tool: 'anima.reminder.schedule',
    });
  }

  async cancel(input: ReminderIdActivityInput, op: () => Promise<Reminder>): Promise<Reminder> {
    return this.recordReminderTool({
      agentId: input.agentId,
      failurePayload: { reminderId: input.id },
      op,
      successPayload: reminderActivityFields,
      tool: 'anima.reminder.cancel',
    });
  }

  async snooze(input: ReminderIdActivityInput, op: () => Promise<Reminder>): Promise<Reminder> {
    return this.recordReminderTool({
      agentId: input.agentId,
      failurePayload: { reminderId: input.id },
      op,
      successPayload: reminderActivityFields,
      tool: 'anima.reminder.snooze',
    });
  }

  async fire(input: {
    agentId: string;
    firedAt?: Date;
    reminder: Reminder;
  }): Promise<void> {
    await this.activity.record(input.agentId, {
      payload: {
        ...reminderActivityPayload('anima.reminder.fire', input.reminder),
        ...(input.firedAt ? { firedAt: input.firedAt.toISOString() } : {}),
        firedCount: input.reminder.firedCount,
        scheduleKind: input.reminder.schedule.kind,
      },
      type: 'tool.call.completed',
    });
  }

  private async recordReminderTool(input: {
    agentId: string;
    failurePayload?: Record<string, unknown>;
    op: () => Promise<Reminder>;
    startedPayload?: Record<string, unknown>;
    successPayload: (reminder: Reminder) => Record<string, unknown>;
    tool: string;
  }): Promise<Reminder> {
    if (input.startedPayload) {
      await this.activity.record(input.agentId, {
        payload: { tool: input.tool, ...input.startedPayload },
        type: 'tool.call.started',
      });
    }
    try {
      const reminder = await input.op();
      await this.activity.record(input.agentId, {
        payload: { tool: input.tool, ...input.successPayload(reminder) },
        type: 'tool.call.completed',
      });
      return reminder;
    } catch (error) {
      await this.activity.record(input.agentId, {
        payload: {
          tool: input.tool,
          ...(input.failurePayload ?? {}),
          error: errorMessage(error),
        },
        type: 'tool.call.failed',
      });
      throw error;
    }
  }
}

export const defaultReminderActivityRecorder = new ReminderActivityRecorder();
