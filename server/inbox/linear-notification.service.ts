import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isHeldInboxItem, type LinearNotificationInboxItem } from '../../shared/inbox.js';
import { wakeQueueServiceForAgent } from './wake-queue.service.js';
import { nowIso } from '../ids.js';
import type { LinearInstallation } from '../storage/schema/linear.store.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import type { LinearWebhook } from '../linear/webhook.js';
import { linearCommentItemId, withLinearCommentLock } from './linear-comment-delivery.js';
import { isStopped, sessionStopped } from '../linear/receipt-state.js';
import { linearCommentText, linearIssueKey, linearNotificationEvent } from '../linear/delivery-text.js';

const Session = z.object({ appUser: z.object({ id: z.string() }) }).nullable();
const CommentThread = z.object({ comment: z.object({ id: z.string(), issueId: z.string().nullable(),
  user: z.object({ id: z.string(), app: z.boolean() }).nullable(),
  issue: z.object({ delegate: z.object({ id: z.string() }).nullable() }).nullable(),
  agentSession: Session, parent: z.object({ id: z.string(), body: z.string(), agentSession: Session, user: z.object({ id: z.string() }).nullable(),
    children: z.object({ nodes: z.array(z.object({ id: z.string() })) }) }).nullable(),
}) });
// Resolve the current delegate with the comment author and thread membership.
const COMMENT_THREAD_QUERY = `query($id:String!,$app:ID!){comment(id:$id){id issueId user{id app} issue{delegate{id}} agentSession{appUser{id}}
  parent{id body agentSession{appUser{id}} user{id} children(first:1,filter:{user:{id:{eq:$app}}}){nodes{id}}}}}`;
const COMMENT_TYPES = new Set(['issueNewComment', 'issueCommentMention']);
const DELIVERED_TYPES = new Set([...COMMENT_TYPES, 'issueUnassignedFromYou', 'issueStatusChanged']);

export class LinearNotificationService {
  constructor(private readonly identity: LinearIdentityService) {}

  async receive(event: Extract<LinearWebhook, { type: 'AppUserNotification' | 'PermissionChange' }>, install: LinearInstallation): Promise<void> {
    const commentId = event.type === 'AppUserNotification' && COMMENT_TYPES.has(event.notification.type) && event.notification.commentId;
    if (commentId) return withLinearCommentLock(this.identity, commentId, () => this.receiveLocked(event, install));
    return this.receiveLocked(event, install);
  }

  async assertRunnable(item: LinearNotificationInboxItem): Promise<void> {
    await this.identity.authorizedInstallation(item.installationId);
    const receipts = Object.values((await this.identity.store.read()).receipts);
    // The comment carried a stopped request, or a session request replaced it and was then stopped.
    if (receipts.some((r) => r.commentItemId === item.id && isStopped(r) || r.heldCommentItemId === item.id && sessionStopped(receipts, r.sessionId))) {
      throw new Error('This Linear comment request was stopped.');
    }
  }

  private async receiveLocked(event: Extract<LinearWebhook, { type: 'AppUserNotification' | 'PermissionChange' }>, install: LinearInstallation): Promise<void> {
    const receivedAt = nowIso();
    await this.identity.store.update((file) => {
      if (file.installation?.id !== install.id || file.installation.revoked) throw new Error('Linear identity changed.');
      return { ...file, lastSignedWebhookAt: receivedAt };
    });
    let key: string;
    let text: string;
    // Mentions, joined threads and human comments on delegated issues wake the
    // agent. Other events wait for its next run.
    let wakes = false;
    const item: LinearNotificationInboxItem = {
      id: '', kind: 'linear_notification', installationId: install.id, organizationId: install.organizationId,
      notificationType: event.action, receivedAt, text: '',
      handling: { status: 'queued', createdAt: receivedAt, updatedAt: receivedAt, queuedAt: receivedAt },
    };
    if (event.type === 'PermissionChange') {
      item.sourceTime = event.createdAt;
      const digest = createHash('sha256').update(JSON.stringify([event.createdAt, event.canAccessAllPublicTeams,
        [...event.addedTeamIds].sort(), [...event.removedTeamIds].sort()])).digest('hex');
      key = `linear:${install.id}:permissions:${digest}`;
      text = [`Linear team access changed. All public teams: ${event.canAccessAllPublicTeams ? 'yes' : 'no'}.`,
        `Added team IDs: ${event.addedTeamIds.join(', ') || 'none'}.`,
        `Removed team IDs: ${event.removedTeamIds.join(', ') || 'none'}.`].join('\n');
    } else {
      const n = event.notification;
      // App-origin mentions may have no AgentSessionEvent. Accept their comment
      // notifications too, but never answer our own comments or duplicate a session.
      if (!DELIVERED_TYPES.has(n.type) || n.archivedAt || n.actorId === install.appUserId || n.comment?.userId === install.appUserId && COMMENT_TYPES.has(n.type)) return;
      if (!n.issue) return;
      key = `linear:${install.id}:notification:${n.id}:${n.commentId ?? n.updatedAt}`;
      const queue = wakeQueueServiceForAgent(this.identity.agentId);
      // Preserve dedupe for notifications queued by earlier versions.
      if (await queue.has(key)) return;
      item.issueId = n.issue.id;
      item.issueUrl = n.issue.url;
      item.issueTitle = n.issue.title;
      item.sourceTime = n.updatedAt;
      if (n.actorId) item.actorId = n.actorId;
      if (n.commentId) item.commentId = n.commentId;
      if (n.parentCommentId) item.parentCommentId = n.parentCommentId;
      if (n.actor?.name) item.actorName = n.actor.name;
      const issueKey = linearIssueKey(n.issue.identifier, n.issue.url);
      if (issueKey) item.issueKey = issueKey;
      // Start with the author's new message; the envelope names the issue.
      text = COMMENT_TYPES.has(n.type) ? n.comment?.body ?? '' : linearNotificationEvent(n.type, issueKey) ?? '';
      if (COMMENT_TYPES.has(n.type) && n.commentId) {
        key = linearCommentItemId(install.id, n.commentId);
        const existing = await queue.has(key);
        if (existing) {
          if (n.type !== 'issueCommentMention') return;
          const queued = await queue.find(key);
          if (!queued || !isHeldInboxItem(queued)) return;
        }
        if (Object.values((await this.identity.store.read()).receipts).some((r) => r.commentId === n.commentId)) return;
        // Replies in this app's work session arrive as immutable AgentActivity
        // prompts. Query the thread before enqueueing the ordinary notification;
        // a failed lookup rejects delivery so Linear can retry it.
        const { comment } = await this.identity.graphql(install.id, COMMENT_THREAD_QUERY,
          { id: n.commentId, app: install.appUserId }, CommentThread);
        if (comment.id !== n.commentId || comment.issueId !== n.issueId) throw new Error('Linear comment notification mismatch.');
        if (comment.agentSession?.appUser.id === install.appUserId || comment.parent?.agentSession?.appUser.id === install.appUserId) return;
        text = linearCommentText(text, comment.parent);
        if (existing) {
          // Promote held context with its current body and root. Already delivered
          // comments remain deduplicated by the queue.
          await this.identity.authorizedInstallation(install.id);
          await queue.releaseHeld(key, { ...item, id: key, text });
          return;
        }
        wakes = n.type === 'issueCommentMention' || comment.parent?.user?.id === install.appUserId
          || Boolean(comment.parent?.children.nodes.length)
          || comment.user?.app === false && comment.issue?.delegate?.id === install.appUserId;
      }
    }
    item.id = key;
    item.text = text;
    await this.identity.authorizedInstallation(install.id);
    // The existing queue atomically deduplicates active and settled inputs. There
    // is no session receipt or acknowledgement here.
    await wakeQueueServiceForAgent(this.identity.agentId).enqueue(item, { holdUntilRun: !wakes });
  }
}
