// Disk schema and store for agents/<agentId>/reminders.json.
//
// The file is agent-scoped and stores a JSON object keyed by reminderId:
//   Record<string, Reminder>
//
// There is intentionally no global reminder store.

import { join } from 'node:path';

import { z } from 'zod';

import { agentsDir } from './agent.store.js';
import { JsonStore } from '../json-store.js';
import { Reminder } from '../../../shared/reminder.js';

const ReminderFileSchema = z.record(z.string(), Reminder);

export type ReminderFile = z.infer<typeof ReminderFileSchema>;

function getReminderFileStore(agentId: string): JsonStore<ReminderFile> {
  return new JsonStore<ReminderFile>({
    empty: () => ({}),
    parse: ReminderFileSchema.parse,
    path: () => join(agentsDir(), agentId, 'reminders.json'),
  });
}

export class ReminderStore {
  private readonly file: JsonStore<ReminderFile>;

  constructor(agentId: string) {
    this.file = getReminderFileStore(agentId);
  }

  async list(): Promise<Reminder[]> {
    return Object.values(await this.file.read());
  }

  async find(reminderId: string): Promise<Reminder | undefined> {
    return (await this.file.read())[reminderId];
  }

  async create(reminder: Reminder): Promise<Reminder> {
    await this.file.update((stored) => {
      if (stored[reminder.reminderId]) throw new Error(`Reminder already exists: ${reminder.reminderId}`);
      return {
        ...stored,
        [reminder.reminderId]: reminder,
      };
    });
    return reminder;
  }

  async update(reminder: Reminder): Promise<Reminder> {
    await this.file.update((stored) => {
      if (!stored[reminder.reminderId]) throw new Error(`Reminder not found: ${reminder.reminderId}`);
      return {
        ...stored,
        [reminder.reminderId]: reminder,
      };
    });
    return reminder;
  }

  /**
   * Atomically read-modify-write one reminder under the JsonStore lock.
   * Return `null` from `mutate` to no-op (stale/CAS miss). Mutate must not
   * rely on mutating `current` in place when returning null.
   */
  async updateMatching(
    reminderId: string,
    mutate: (current: Reminder) => Reminder | null,
  ): Promise<{ applied: boolean; reminder: Reminder | undefined }> {
    let applied = false;
    let result: Reminder | undefined;
    await this.file.update((stored) => {
      const current = stored[reminderId];
      if (!current) {
        result = undefined;
        return stored;
      }
      const next = mutate(structuredClone(current));
      if (!next) {
        result = current;
        return stored;
      }
      applied = true;
      result = next;
      return {
        ...stored,
        [reminderId]: next,
      };
    });
    return { applied, reminder: result };
  }

  async pruneSettledBefore(cutoffIso: string): Promise<number> {
    let pruned = 0;
    await this.file.update((stored) => {
      const next: ReminderFile = {};
      for (const [reminderId, reminder] of Object.entries(stored)) {
        if (isSettledBefore(reminder, cutoffIso)) {
          pruned += 1;
        } else {
          next[reminderId] = reminder;
        }
      }
      return pruned > 0 ? next : stored;
    });
    return pruned;
  }
}

function isSettledBefore(reminder: Reminder, cutoffIso: string): boolean {
  if (reminder.status === 'scheduled') return false;
  const settledAt = reminder.cancelledAt ?? reminder.lastFiredAt ?? reminder.updatedAt;
  return settledAt < cutoffIso;
}
