import type { Activity, AgentActivityAfterPage, AgentActivityFeedPage } from '../../shared/activity.js';
import { normalizeHistoryLimit } from '../../shared/messages.js';
import { ActivityStore, type ActivityRecordInput } from '../storage/schema/activity.store.js';

export interface ActivityListInput {
  before?: string;
  cursor?: string;
  limit?: number;
}

export interface ActivityAfterInput extends ActivityListInput {
  after: string;
}

export interface ActivityRecorder {
  record(agentId: string, input: ActivityRecordInput): Promise<Activity>;
}

export class ActivityService {
  constructor(
    agentId: string,
    private readonly store: ActivityStore = new ActivityStore(agentId),
  ) {}

  record(input: ActivityRecordInput): Promise<Activity> {
    return this.store.record(input);
  }

  readAll(): Promise<Activity[]> {
    return this.store.readAll();
  }

  readLastN(n: number): Promise<Activity[]> {
    return this.store.readLastN(n);
  }

  /** Newest `n` activities matching a predicate, newest-first. */
  readNewestMatching(n: number, matches: (activity: Activity) => boolean): Promise<Activity[]> {
    return this.store.readNewestMatching(n, matches);
  }

  readNewestUntil(shouldStop: (activity: Activity) => boolean): Promise<Activity[]> {
    return this.store.readNewestUntil(shouldStop);
  }

  async listActivityFeed(input: ActivityListInput = {}): Promise<AgentActivityFeedPage> {
    const limit = normalizeHistoryLimit(input.limit);
    return this.store.readPage({ ...input, limit });
  }

  async listActivityFeedAfter(input: ActivityAfterInput): Promise<AgentActivityAfterPage> {
    const limit = normalizeHistoryLimit(input.limit);
    return this.store.readAfter({ ...input, limit });
  }

}

export function activityServiceForAgent(agentId: string): ActivityService {
  return new ActivityService(agentId);
}

export const defaultActivityRecorder: ActivityRecorder = {
  record: (agentId, input) => activityServiceForAgent(agentId).record(input),
};
