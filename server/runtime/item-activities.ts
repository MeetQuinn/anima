import { wakeQueueServiceForAgent, type InboxItem } from '../inbox/wake-queue.service.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import type { Activity } from '../../shared/activity.js';

export async function activitiesForInboxItemWindow(agentId: string, itemId: string): Promise<Activity[]> {
  const activities = await activityServiceForAgent(agentId).readAll();
  const tagged = activities.filter((activity) => taggedToItem(activity, itemId));
  if (tagged.length > 0) return sortActivities(tagged);

  const item = await wakeQueueServiceForAgent(agentId).find(itemId);
  const current = item ? activities.filter((activity) => activityFallsWithinItemHandling(activity, item)) : [];
  return sortActivities(current);
}

function taggedToItem(activity: Activity, itemId: string): boolean {
  return activity.payload?.['itemId'] === itemId || activity.payload?.['activeItemId'] === itemId;
}

function sortActivities(activities: Activity[]): Activity[] {
  return activities.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function activityFallsWithinItemHandling(activity: Activity, item: InboxItem): boolean {
  const handling = item.handling;
  const start = handling.startedAt ?? handling.queuedAt ?? handling.createdAt;
  if (activity.createdAt < start) return false;
  const end = terminalHandlingStatus(handling.status) ? handling.updatedAt : undefined;
  if (end && activity.createdAt > end) return false;
  return true;
}

function terminalHandlingStatus(status: InboxItem['handling']['status']): boolean {
  return status === 'completed' || status === 'failed';
}
