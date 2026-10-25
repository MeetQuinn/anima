import { join } from 'node:path';

import { z } from 'zod';

import { JsonStore } from '../json-store.js';
import { agentsDir } from './agent.store.js';

const TaskName = z.object({
  sessionId: z.string(),
  taskId: z.string(),
  subject: z.string(),
});
type TaskName = z.infer<typeof TaskName>;

// Display cache, not the provider's task list. Old entries may fall back to IDs.
const MAX_TASK_NAMES = 1_000;

export class ProviderTaskNameStore {
  private readonly file: JsonStore<TaskName[]>;

  constructor(agentId: string) {
    this.file = new JsonStore({
      empty: () => [],
      parse: z.array(TaskName).max(MAX_TASK_NAMES).parse,
      path: () => join(agentsDir(), agentId, 'claude-task-names.json'),
    });
  }

  async find(sessionId: string, taskId: string): Promise<string | undefined> {
    return (await this.file.read()).find((entry) => entry.sessionId === sessionId && entry.taskId === taskId)?.subject;
  }

  async put(sessionId: string, taskId: string, subject: string | undefined): Promise<void> {
    await this.file.update((entries) => {
      const next = entries.filter((entry) => entry.sessionId !== sessionId || entry.taskId !== taskId);
      if (subject) next.push({ sessionId, taskId, subject });
      return next.slice(-MAX_TASK_NAMES);
    });
  }
}
