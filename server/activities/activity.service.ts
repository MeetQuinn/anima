import type { Activity, AgentActivityFeedEvent, AgentActivityFeedPage } from '../../shared/activity.js';
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

  readSince(createdAt: string): Promise<Activity[]> {
    return this.store.readSince(createdAt);
  }

  async listActivityFeed(input: ActivityListInput = {}): Promise<AgentActivityFeedPage> {
    const limit = normalizeActivityLimit(input.limit);
    const activities = input.before
      ? await this.store.readBefore(input.before, limit)
      : await this.store.readLastN(limit);
    const events = activities.map(activityFeedEvent)
      .filter((event) => !input.before || event.timestamp < input.before)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .slice(-limit);
    const nextCursor = events.length >= limit ? (events[0]?.timestamp ?? null) : null;
    return { events, nextCursor };
  }

}

export function activityServiceForAgent(agentId: string): ActivityService {
  return new ActivityService(agentId);
}

export const defaultActivityRecorder: ActivityRecorder = {
  record: (agentId, input) => activityServiceForAgent(agentId).record(input),
};

function normalizeActivityLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(1, Math.trunc(limit as number)), 500);
}

function activityFeedEvent(activity: Activity): AgentActivityFeedEvent {
  return { activity, kind: 'activity', timestamp: activity.createdAt };
}
