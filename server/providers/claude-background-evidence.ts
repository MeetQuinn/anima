import { isRecord, stringField } from '../json.js';
import type { ProviderWorkSnapshot } from '../../shared/snapshot.js';

type Evidence = NonNullable<ProviderWorkSnapshot['backgroundEvidence']>;
const safeTaskId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);

/** Diagnostic streams only. Terminal edges never replace the native live-list signal. */
export class ClaudeBackgroundEvidence {
  private receivedAt?: string;
  private ids: string[] = [];
  private ambientIds: string[] = [];
  private truncated = false;
  private notifications: Evidence['terminalNotifications'] = [];

  record(value: Record<string, unknown>, receivedAt = new Date().toISOString()): void {
    if (stringField(value, 'type') !== 'system') return;
    const subtype = stringField(value, 'subtype');
    if (subtype === 'background_tasks_changed' && Array.isArray(value['tasks'])) {
      const tasks = value['tasks'];
      const ids = [
        ...new Set(
          tasks.flatMap((task) =>
            isRecord(task) && safeTaskId(task['task_id']) ? [task['task_id']] : [],
          ),
        ),
      ];
      this.receivedAt = receivedAt;
      this.ids = ids.slice(0, 32);
      this.ambientIds = this.ids.filter((id) =>
        tasks.some(
          (task: unknown) => isRecord(task) && task['task_id'] === id && task['ambient'] === true,
        ),
      );
      this.truncated = ids.length > this.ids.length || ids.length < tasks.length;
    }
    if (subtype === 'task_notification' && safeTaskId(value['task_id'])) {
      const status = stringField(value, 'status');
      if (status !== 'completed' && status !== 'failed' && status !== 'stopped') return;
      this.notifications.push({ taskId: value['task_id'], status, receivedAt });
      if (this.notifications.length > 16) this.notifications.shift();
    }
  }

  snapshot(): Evidence | undefined {
    if (!this.receivedAt) return;
    return {
      snapshotReceivedAt: this.receivedAt,
      listedTaskIds: [...this.ids],
      ambientTaskIds: [...this.ambientIds],
      listedTaskIdsTruncated: this.truncated,
      terminalNotifications: this.notifications.map((notification) => ({ ...notification })),
    };
  }
}
