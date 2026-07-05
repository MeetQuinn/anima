import type { Activity, AgentActivityFeedPage } from '../../shared/activity.js';
import { normalizeHistoryLimit } from '../../shared/messages.js';
import { ActivityStore, type ActivityRecordInput } from '../storage/schema/activity.store.js';

export interface ActivityListInput {
  before?: string;
  limit?: number;
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
    const activities = input.before
      ? await this.store.readBefore(input.before, limit)
      : await this.store.readLastN(limit);
    const events = activities;
    const nextCursor = events.length >= limit ? (events[0]?.createdAt ?? null) : null;
    return { events, nextCursor };
  }

}

export function activityServiceForAgent(agentId: string): ActivityService {
  return new ActivityService(agentId);
}

export const defaultActivityRecorder: ActivityRecorder = {
  record: (agentId, input) => activityServiceForAgent(agentId).record(input),
};
