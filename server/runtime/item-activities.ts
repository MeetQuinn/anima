import { wakeQueueServiceForAgent, type InboxItem } from '../inbox/wake-queue.service.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import type { Activity } from '../../shared/activity.js';

export async function activitiesForInboxItemWindow(agentId: string, itemId: string): Promise<Activity[]> {
  const item = await wakeQueueServiceForAgent(agentId).find(itemId);
  if (!item) {
    const allActivities = await activityServiceForAgent(agentId).readAll();
    return sortActivities(allActivities.filter((activity) => taggedToItem(activity, itemId)));
  }

  const activities = await activityServiceForAgent(agentId)
    .readNewestUntil((activity) => activity.createdAt < item.handling.createdAt);
  const tagged = activities.filter((activity) => taggedToItem(activity, itemId));
  if (tagged.length > 0) return sortActivities(tagged);

  const current = activities.filter((activity) => activityFallsWithinItemHandling(activity, item));
  return sortActivities(current);
}

/**
 * Activities tagged to an item that may already have left the wake queue (the
 * settle hooks run after `complete`). Activity rows are stamped at append, so
 * nothing tagged to the item predates its creation: the read stops there
 * instead of parsing every archive segment.
 */
export async function activitiesTaggedToItem(agentId: string, item: InboxItem): Promise<Activity[]> {
  const activities = await activityServiceForAgent(agentId)
    .readNewestUntil((activity) => activity.createdAt < item.handling.createdAt);
  return sortActivities(activities.filter((activity) => taggedToItem(activity, item.id)));
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
