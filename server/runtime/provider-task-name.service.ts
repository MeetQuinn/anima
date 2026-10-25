import { stringField } from '../json.js';
import { ProviderTaskNameStore } from '../storage/schema/provider-task-name.store.js';

export class ProviderTaskNameService {
  constructor(private readonly store: ProviderTaskNameStore) {}

  async remember(payload: Record<string, unknown>): Promise<void> {
    const sessionId = stringField(payload, 'taskSessionId');
    const taskId = stringField(payload, 'taskId');
    if (!sessionId || !taskId) return;
    await this.store.put(sessionId, taskId, stringField(payload, 'taskSubject'));
  }

  async enrich(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (payload['provider'] !== 'claude-code' || payload['providerToolName'] !== 'TaskUpdate' || payload['taskSubject']) return payload;
    const sessionId = stringField(payload, 'taskSessionId');
    const taskId = stringField(payload, 'taskId');
    if (!sessionId || !taskId) return payload;
    const subject = await this.store.find(sessionId, taskId);
    if (!subject) return payload;
    return { ...payload, taskSubject: subject, target: subject };
  }
}
