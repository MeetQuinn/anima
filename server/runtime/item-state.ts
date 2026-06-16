import { isPrimaryRunningInboxItem, type InboxItem } from '../../shared/inbox.js';
import type { AgentRuntimeHandleSnapshot } from '../../shared/snapshot.js';

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

export function providerChildIssueReason(
  runtime: AgentRuntimeHandleSnapshot,
  options: { checkPid?: boolean } = {},
): 'provider_child_missing' | 'provider_child_exited' | undefined {
  if (!runtime.providerChildExpected) return undefined;
  const child = runtime.providerChild;
  if (!child) return 'provider_child_missing';
  if (options.checkPid && child.pid && !processAlive(child.pid)) return 'provider_child_exited';
  if (child.exited || !child.alive || !child.stdinWritable) return 'provider_child_exited';
  return undefined;
}
