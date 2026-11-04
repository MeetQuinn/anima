import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { LinearInstallation } from '../storage/schema/linear.store.js';

const Id = z.string().uuid();
const Time = z.string().datetime({ offset: true });
// Decorative: a malformed avatar is dropped and never rejects the event.
const AvatarUrl = z.string().max(2048).nullish().catch(undefined);
const User = z.object({ id: Id, name: z.string().max(512), avatarUrl: AvatarUrl });
const Comment = z.object({ id: Id.optional(), body: z.string().max(100_000), userId: Id.nullish() });
const Common = z.object({ organizationId: Id, oauthClientId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/), webhookTimestamp: z.number().finite() });
const Session = z.object({
  id: Id, appUserId: Id, organizationId: Id, issueId: Id.nullish(), commentId: Id.nullish(), sourceCommentId: Id.nullish(), url: z.string().url().nullish(),
  createdAt: Time.optional(),
  // The identifier only names the issue in the prompt; an odd one is dropped, never rejected.
  issue: z.object({ id: Id, identifier: z.string().nullish().catch(undefined), title: z.string(), description: z.string().nullish(), url: z.string().url().nullish() }).nullish(),
  comment: Comment.nullish(),
  creatorId: Id.nullish(), creator: z.object({ name: z.string().max(512), avatarUrl: AvatarUrl }).nullish(),
});
const Prompt = z.object({
  id: Id, agentSessionId: Id, signal: z.string().nullish(), body: z.string().max(100_000).optional(),
  createdAt: Time.optional(), userId: Id.nullish(), user: User.nullish(),
  content: z.object({ type: z.literal('prompt'), body: z.string().max(100_000) }).optional(),
});
const Notification = z.object({
  id: Id, type: z.string().min(1), userId: Id, createdAt: Time, updatedAt: Time,
  actorId: Id.nullish(), actor: User.nullish(), archivedAt: z.string().nullish(),
  issueId: Id.nullish(), issue: z.object({ id: Id, identifier: z.string(), title: z.string(), url: z.string().url() }).nullish(),
  commentId: Id.nullish(), comment: z.object({ id: Id, body: z.string().max(100_000), userId: Id.nullish(), issueId: Id.nullish() }).nullish(),
  parentCommentId: Id.nullish(),
});
export const LinearWebhook = z.discriminatedUnion('type', [
  Common.extend({ type: z.literal('AgentSessionEvent'), action: z.enum(['created', 'prompted']),
    createdAt: Time.optional(), previousComments: z.array(Comment).nullish(),
    appUserId: Id, agentSession: Session, promptContext: z.string().max(200_000).nullish(), agentActivity: Prompt.optional(),
    guidance: z.array(z.object({ body: z.string().max(50_000),
      origin: z.object({ type: z.string(), team: z.object({ name: z.string() }).optional() }).optional(),
    })).max(100).nullish(),
  }),
  Common.extend({ type: z.literal('OAuthApp'), action: z.literal('revoked') }),
  Common.extend({ type: z.literal('AppUserNotification'), action: z.string().min(1), appUserId: Id, notification: Notification }),
  Common.extend({ type: z.literal('PermissionChange'), action: z.literal('teamAccessChanged'), appUserId: Id,
    createdAt: z.string().datetime(), canAccessAllPublicTeams: z.boolean(), addedTeamIds: z.array(Id).max(10_000), removedTeamIds: z.array(Id).max(10_000),
  }),
]);
export type LinearWebhook = z.infer<typeof LinearWebhook>;

export interface LinearSender { id: string; name?: string; avatarUrl?: string }

// The person behind an event, as the payload describes them.
export function linearEventSender(event: LinearWebhook): LinearSender | undefined {
  let id: string | null | undefined;
  let user: { name: string; avatarUrl?: string | null } | null | undefined;
  if (event.type === 'AgentSessionEvent' && event.action === 'prompted') {
    user = event.agentActivity?.user; id = event.agentActivity?.user?.id ?? event.agentActivity?.userId;
  } else if (event.type === 'AgentSessionEvent') {
    user = event.agentSession.creator; id = event.agentSession.creatorId;
  } else if (event.type === 'AppUserNotification') {
    user = event.notification.actor; id = event.notification.actor?.id ?? event.notification.actorId;
  }
  // Only a payload that describes the user can refresh what is known about them.
  if (!id || !user) return undefined;
  return { id, ...(user.name ? { name: user.name } : {}), ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}) };
}

export function signatureMatches(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature) || !secret) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function verifyLinearWebhook(raw: Buffer, signature: string | undefined, installation: LinearInstallation, now = Date.now()): LinearWebhook {
  if (installation.revoked || !signatureMatches(raw, signature, installation.signingSecret)) throw new Error('Invalid Linear signature');
  let event: LinearWebhook;
  try { event = LinearWebhook.parse(JSON.parse(raw.toString('utf8'))); }
  catch { throw new Error('Unsupported or invalid Linear event'); }
  if (Math.abs(now - event.webhookTimestamp) > 60_000) throw new Error('Expired Linear webhook');
  if (event.organizationId !== installation.organizationId || event.oauthClientId !== installation.clientId) throw new Error('Linear installation mismatch');
  if (event.type === 'AgentSessionEvent') {
    if (event.appUserId !== installation.appUserId || event.agentSession.appUserId !== installation.appUserId
      || event.agentSession.organizationId !== installation.organizationId) throw new Error('Linear session identity mismatch');
    if (event.agentSession.issue && event.agentSession.issueId !== event.agentSession.issue.id) throw new Error('Linear issue identity mismatch');
    if (event.action === 'prompted') {
      if (!event.agentActivity || event.agentActivity.agentSessionId !== event.agentSession.id) throw new Error('Missing Linear prompt');
      if (event.agentActivity.user && event.agentActivity.userId && event.agentActivity.user.id !== event.agentActivity.userId) throw new Error('Linear prompt author mismatch');
      if (event.agentActivity.signal !== 'stop' && !(event.agentActivity.body ?? event.agentActivity.content?.body)?.trim()) throw new Error('Empty Linear prompt');
    }
  }
  if (event.type === 'AppUserNotification' || event.type === 'PermissionChange') {
    if (event.appUserId !== installation.appUserId) throw new Error('Linear notification identity mismatch');
  }
  if (event.type === 'AppUserNotification') {
    const n = event.notification;
    if (n.userId !== installation.appUserId || n.type !== event.action
      || (n.actor && n.actorId !== n.actor.id)
      || (n.issue && n.issueId !== n.issue.id)
      || (n.comment && (n.commentId !== n.comment.id || (n.comment.issueId && n.issueId !== n.comment.issueId)))) {
      throw new Error('Linear notification resource mismatch');
    }
    if (['issueNewComment', 'issueCommentMention', 'issueCommentReaction'].includes(event.action) && (!n.comment || !n.issue)) {
      throw new Error('Missing Linear comment notification context');
    }
  }
  return event;
}
