import { isPrimaryRunningInboxItem, type InboxItem } from '../../shared/inbox.js';

export function latestPrimaryRunningItem(items: InboxItem[]): InboxItem | undefined {
  return items
    .filter((item) => isPrimaryRunningInboxItem(item))
    .sort((a, b) => {
      const aTime = a.handling.startedAt ?? a.handling.updatedAt;
      const bTime = b.handling.startedAt ?? b.handling.updatedAt;
      return bTime.localeCompare(aTime);
    })[0];
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}
