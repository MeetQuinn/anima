import { join } from 'node:path';
import { withFileLock } from '../storage/lock.js';
import type { LinearIdentityService } from '../linear/identity.service.js';

// Notification IDs differ for a mention and an ordinary comment notification.
// The comment, scoped to this installation, is the shared delivery identity.
export const linearCommentItemId = (installationId: string, commentId: string): string =>
  `linear:${installationId}:comment:${commentId}`;

// Serialize notification intake with session creation/Stop for this comment.
// The queue and session receipts remain the durable authorities after restart.
export function withLinearCommentLock<T>(identity: LinearIdentityService, commentId: string, op: () => Promise<T>): Promise<T> {
  const home = identity.store.animaHome;
  return withFileLock(join(home, 'agents', identity.agentId, `linear-comment-${commentId}`), home, op);
}
