import { z } from 'zod';
import type { LinearInboxItem, LinearNotificationInboxItem } from '../../shared/inbox.js';

/**
 * Where a Linear reply goes. The envelope's `reply_to` carries it; the agent passes it back
 * unchanged and Anima picks the write: a session activity, a threaded comment, or a new
 * comment on the issue.
 */
export type LinearReplyTarget =
  | { kind: 'session'; id: string }
  | { kind: 'comment'; id: string }
  | { kind: 'issue'; id: string };

const Uuid = z.string().uuid();
const IssueRef = z.string().trim().min(1).max(256);

export function formatLinearReplyTarget(target: LinearReplyTarget): string {
  return `${target.kind}:${target.id}`;
}

export function parseLinearReplyTarget(value: string): LinearReplyTarget {
  const match = /^(session|comment|issue):(.+)$/.exec(value.trim());
  const invalid = () => new Error('Use the reply_to value from the Linear envelope: session:<uuid>, comment:<uuid> or issue:<id>.');
  if (!match) throw invalid();
  const kind = match[1] as LinearReplyTarget['kind'];
  const id = (kind === 'issue' ? IssueRef : Uuid).safeParse(match[2]);
  if (!id.success) throw invalid();
  return { kind, id: id.data };
}

/** A session request is answered in its session; a comment in its thread's root; anything else on its issue. */
export function linearReplyTargetFor(item: LinearInboxItem | LinearNotificationInboxItem): LinearReplyTarget | undefined {
  if (item.kind === 'linear') return { kind: 'session', id: item.sessionId };
  const comment = item.parentCommentId ?? item.commentId;
  if (comment) return { kind: 'comment', id: comment };
  return item.issueId ? { kind: 'issue', id: item.issueId } : undefined;
}
