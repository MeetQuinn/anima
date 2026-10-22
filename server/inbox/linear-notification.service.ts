import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LinearNotificationInboxItem } from '../../shared/inbox.js';
import { wakeQueueServiceForAgent } from './wake-queue.service.js';
import { nowIso } from '../ids.js';
import type { LinearInstallation } from '../storage/schema/linear.store.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import type { LinearWebhook } from '../linear/webhook.js';

const Session = z.object({ appUser: z.object({ id: z.string() }) }).nullable();
const CommentThread = z.object({ comment: z.object({ id: z.string(), issueId: z.string().nullable(),
  agentSession: Session, parent: z.object({ agentSession: Session }).nullable(),
}) });
const WAKE_TYPES = new Set(['issueNewComment', 'issueUnassignedFromYou', 'issueStatusChanged']);

export class LinearNotificationService {
  constructor(private readonly identity: LinearIdentityService) {}

  async receive(event: Extract<LinearWebhook, { type: 'AppUserNotification' | 'PermissionChange' }>, install: LinearInstallation): Promise<void> {
    const receivedAt = nowIso();
    await this.identity.store.update((file) => {
      if (file.installation?.id !== install.id || file.installation.revoked) throw new Error('Linear identity changed.');
      return { ...file, lastSignedWebhookAt: receivedAt };
    });
    let key: string;
    let text: string;
    const item: LinearNotificationInboxItem = {
      id: '', kind: 'linear_notification', installationId: install.id, organizationId: install.organizationId,
      notificationType: event.action, receivedAt, text: '',
      handling: { status: 'queued', createdAt: receivedAt, updatedAt: receivedAt, queuedAt: receivedAt },
    };
    if (event.type === 'PermissionChange') {
      const digest = createHash('sha256').update(JSON.stringify([event.createdAt, event.canAccessAllPublicTeams,
        [...event.addedTeamIds].sort(), [...event.removedTeamIds].sort()])).digest('hex');
      key = `linear:${install.id}:permissions:${digest}`;
      text = [`Linear team access changed. All public teams: ${event.canAccessAllPublicTeams ? 'yes' : 'no'}.`,
        `Added team IDs: ${event.addedTeamIds.join(', ') || 'none'}.`,
        `Removed team IDs: ${event.removedTeamIds.join(', ') || 'none'}.`,
        'Use anima linear teams to check current access before continuing affected work.'].join('\n');
    } else {
      const n = event.notification;
      // Mentions and assignment already arrive through AgentSessionEvent. Ordinary
      // notifications must not create a second task or answer our own comments.
      if (!WAKE_TYPES.has(n.type) || n.archivedAt || n.actorId === install.appUserId || n.comment?.userId === install.appUserId && n.type === 'issueNewComment') return;
      if (!n.issue) return;
      key = `linear:${install.id}:notification:${n.id}:${n.commentId ?? n.updatedAt}`;
      const queue = wakeQueueServiceForAgent(this.identity.agentId);
      if (await queue.has(key)) return;
      if (n.type === 'issueNewComment' && n.commentId) {
        // Replies in this app's work session arrive as immutable AgentActivity
        // prompts. Query the thread before enqueueing the ordinary notification;
        // a failed lookup rejects delivery so Linear can retry it.
        const { comment } = await this.identity.graphql(install.id,
          'query($id:String!){comment(id:$id){id issueId agentSession{appUser{id}} parent{agentSession{appUser{id}}}}}',
          { id: n.commentId }, CommentThread);
        if (comment.id !== n.commentId || comment.issueId !== n.issueId) throw new Error('Linear comment notification mismatch.');
        if (comment.agentSession?.appUser.id === install.appUserId || comment.parent?.agentSession?.appUser.id === install.appUserId) return;
      }
      item.issueId = n.issue.id;
      item.issueUrl = n.issue.url;
      if (n.commentId) item.commentId = n.commentId;
      if (n.parentCommentId) item.parentCommentId = n.parentCommentId;
      if (n.actor?.name) item.actorName = n.actor.name;
      text = [`${n.issue.identifier}: ${n.issue.title}`, `Event: ${n.type}.`, n.comment?.body].filter(Boolean).join('\n\n');
    }
    item.id = key;
    item.text = text;
    await this.identity.authorizedInstallation(install.id);
    // The existing queue atomically deduplicates active and settled inputs. There
    // is no session receipt, acknowledgement, or missing-response fallback here.
    await wakeQueueServiceForAgent(this.identity.agentId).enqueue(item);
  }
}
