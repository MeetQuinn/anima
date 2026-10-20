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
 * How far before an item's creation the settle-time read keeps scanning.
 * Rows are stamped under the activity log's file lock, so append order is
 * `createdAt` order as long as the wall clock does not step backwards. The
 * margin is a finite tolerance, not a guarantee: it covers a row stamped up to
 * ten minutes out of order (a small clock step, a lock broken as stale after
 * five minutes, a runtime that still stamps before taking the lock). A larger
 * backwards clock step or a writer stalled past the margin can still land a
 * row the read never reaches.
 */
const ITEM_ACTIVITY_SCAN_MARGIN_MS = 10 * 60 * 1000;

/**
 * Activities tagged to an item that may already have left the wake queue (the
 * settle hooks run after `complete`). Nothing tagged to the item is stamped
 * before its creation, so the read stops a margin before that instead of
 * parsing every archive segment.
 */
export async function activitiesTaggedToItem(agentId: string, item: InboxItem): Promise<Activity[]> {
  const createdMs = Date.parse(item.handling.createdAt);
  const stopBefore = Number.isFinite(createdMs)
    ? new Date(createdMs - ITEM_ACTIVITY_SCAN_MARGIN_MS).toISOString()
    : undefined;
  const newestFirst = await activityServiceForAgent(agentId)
    .readNewestUntil((activity) => stopBefore !== undefined && activity.createdAt < stopBefore);
  // Back to append order first, so rows stamped in the same millisecond keep it.
  return sortActivities(newestFirst.reverse().filter((activity) => taggedToItem(activity, item.id)));
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
