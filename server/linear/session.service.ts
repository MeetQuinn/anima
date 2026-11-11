import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { LinearActivityKind } from '../../shared/linear.js';
import { isHeldInboxItem, type LinearInboxItem, type InboxItem } from '../../shared/inbox.js';
import { nowIso } from '../ids.js';
import { wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import { linearCommentItemId, withLinearCommentLock } from '../inbox/linear-comment-delivery.js';
import { withFileLock } from '../storage/lock.js';
import type { LinearInstallation, LinearOperation, LinearReceipt } from '../storage/schema/linear.store.js';
import { LinearIdentityService, linearRequestNotSent } from './identity.service.js';
import { awaitsAcknowledgement, claimable, closeReceipt, endRun, isActiveRequest, isOpenRequest, isStopped, requeueReceipt, startReceipt, stopReceipt } from './receipt-state.js';
import { LinearApiError } from './client.js';
import type { LinearWebhook } from './webhook.js';
import { linearCommentText, linearIssueKey } from './delivery-text.js';

const Created = z.object({ agentActivityCreate: z.object({ success: z.literal(true), agentActivity: z.object({ id: z.string() }) }) });
const ReadActivity = z.object({ agentActivity: z.object({ id: z.string(), agentSession: z.object({ id: z.string() }) }) });
const SourceComment = z.object({ comment: z.object({ id: z.string(), issueId: z.string().nullable(), body: z.string(),
  user: z.object({ id: z.string(), name: z.string() }).nullable(), parent: z.object({ id: z.string(), body: z.string(),
    user: z.object({ id: z.string() }).nullable(), children: z.object({ nodes: z.array(z.object({ id: z.string() })) }),
  }).nullable(),
}) });
const SELF_DELEGATED_BODY = 'Received by Anima. This agent delegated the issue to itself, so this session ends here. Its progress shows in the issue status and comments.';
const contentHash = (kind: string, body: string) => createHash('sha256').update(JSON.stringify([kind, body])).digest('hex');
const sessionFields = 'id appUser{id} creator{id} issue{id identifier title url} comment{id} status url';
const SessionOrigin = z.object({ agentSession: z.object({
  id: z.string().uuid(), appUser: z.object({ id: z.string() }), creator: z.object({ id: z.string() }).nullable(),
  issue: z.object({ id: z.string() }).nullable(), createdAt: z.string().datetime({ offset: true }),
  activities: z.object({ nodes: z.array(z.object({ createdAt: z.string().datetime({ offset: true }),
    promptAuthor: z.object({ id: z.string(), name: z.string().max(512).optional() }).nullable(), content: z.object({ type: z.string().optional() }),
  })).max(1) }),
}) });
const SessionDetails = z.object({ id: z.string().uuid(), appUser: z.object({ id: z.string() }),
  creator: z.object({ id: z.string() }).nullable(),
  issue: z.object({ id: z.string(), identifier: z.string(), title: z.string(), url: z.string() }).nullable(),
  comment: z.object({ id: z.string() }).nullable(), status: z.string(), url: z.string().url().nullable(),
});
type SessionReply = Pick<LinearReceipt, 'issueId' | 'issueKey' | 'issueTitle' | 'issueUrl'> & {
  activityId: string; bookkeeping: 'recorded' | 'degraded';
};

// Linear retries a delivery for at most a few hours, so a finished receipt has done its
// deduplication long before 30 days. Without a limit, linear.json kept every receipt
// of every session ever seen.
const FINISHED_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Drops receipts finished more than 30 days ago, then operations whose session has no receipt left. */
function withoutExpiredReceipts(receipts: Record<string, LinearReceipt>, operations: Record<string, LinearOperation>, now: number) {
  const cutoff = now - FINISHED_RECEIPT_RETENTION_MS;
  const kept = Object.fromEntries(Object.entries(receipts).filter(([, r]) => {
    // An open request can still be answered, even long after its run ended.
    if (isOpenRequest(r)) return true;
    const last = Math.max(...[r.receivedAt, r.lastActivityAt, r.lastStatusAttemptAt].map((at) => (at ? Date.parse(at) : 0)));
    return !(last < cutoff);
  }));
  const sessions = new Set(Object.values(kept).map((r) => r.sessionId));
  return { receipts: kept, operations: Object.fromEntries(Object.entries(operations).filter(([, op]) => sessions.has(op.sessionId))) };
}

export class LinearSessionService {
  // Worker hooks are best effort. Keep the actual accepted owner until its journal
  // write succeeds, even when the queue has already removed the settled input.
  private readonly pendingOwners = new Map<string, { installationId: string; runItemId: string }>();
  constructor(readonly identity: LinearIdentityService) {}
  get agentId(): string { return this.identity.agentId; }

  async start(target: 'issue' | 'comment', targetId: string, requestId: string, runItemId?: string): Promise<z.infer<typeof SessionDetails>> {
    z.string().uuid().parse(requestId);
    const install = await this.identity.authorizedInstallation();
    const home = this.identity.store.animaHome;
    return withFileLock(join(home, 'agents', this.agentId, `linear-start-${requestId}`), home, async () => {
      const previous = (await this.identity.store.read()).sessionStarts[requestId];
      if (previous) {
        if (previous.target !== target || previous.targetId !== targetId) throw new Error('This request id belongs to a different Linear target.');
        if (!previous.sessionId) throw new Error(`Previous session creation is unknown (started ${previous.createdAt}). Inspect Linear; do not create another session blindly.`);
        return this.sessionDetails(install, previous.sessionId);
      }
      // Resolve identifiers and comment replies before recording the send intent.
      // Linear only accepts a root comment as a proactive session target.
      let rootId: string;
      if (target === 'comment') {
        const result = await this.identity.graphql(install.id, 'query($id:String!){comment(id:$id){id parent{id}}}', { id: targetId },
          z.object({ comment: z.object({ id: z.string(), parent: z.object({ id: z.string() }).nullable() }) }));
        rootId = result.comment.parent?.id ?? result.comment.id;
      } else {
        const result = await this.identity.graphql(install.id, 'query($id:String!){issue(id:$id){id}}', { id: targetId },
          z.object({ issue: z.object({ id: z.string().uuid() }) }));
        rootId = result.issue.id;
      }
      await this.identity.store.update((file) => {
        if (file.installation?.id !== install.id || file.installation.revoked) throw new Error('Linear identity changed.');
        return { ...file, sessionStarts: { ...file.sessionStarts, [requestId]: { target, targetId, rootId, createdAt: nowIso() } } };
      });
      const field = target === 'issue' ? 'agentSessionCreateOnIssue' : 'agentSessionCreateOnComment';
      const inputType = target === 'issue' ? 'AgentSessionCreateOnIssue' : 'AgentSessionCreateOnComment';
      const input = target === 'issue' ? { issueId: rootId } : { commentId: rootId };
      const result = await this.identity.graphql(install.id,
        `mutation($input:${inputType}!){${field}(input:$input){success agentSession{${sessionFields}}}}`, { input },
        z.record(z.string(), z.object({ success: z.literal(true), agentSession: SessionDetails })));
      const session = result[field]!.agentSession;
      if (session.appUser.id !== install.appUserId || session.creator) throw new Error('Linear returned an unexpected session owner. Inspect Linear before retrying.');
      if ((target === 'issue' ? session.issue?.id : session.comment?.id) !== rootId) throw new Error('Linear returned a different session target. Inspect Linear before retrying.');
      await this.sessionLock(session.id, async () => {
        await this.identity.store.update((file) => {
          if (file.installation?.id !== install.id || file.installation.revoked) throw new Error('Linear identity changed after session creation.');
          return { ...file, sessionStarts: { ...file.sessionStarts, [requestId]: { ...file.sessionStarts[requestId]!, sessionId: session.id } } };
        });
        await this.registerProactive(install.id, session, runItemId);
      });
      return session;
    });
  }

  async receive(event: Extract<LinearWebhook, { type: 'OAuthApp' | 'AgentSessionEvent' }>, install: LinearInstallation): Promise<void> {
    const commentId = event.type === 'AgentSessionEvent' && (event.agentSession.sourceCommentId ?? event.agentSession.commentId);
    if (commentId) return withLinearCommentLock(this.identity, commentId, () => this.receiveLocked(event, install));
    return this.receiveLocked(event, install);
  }

  private async receiveLocked(event: Extract<LinearWebhook, { type: 'OAuthApp' | 'AgentSessionEvent' }>, install: LinearInstallation): Promise<void> {
    if (event.type === 'OAuthApp') {
      await this.identity.store.update((file) => file.installation?.id === install.id ? { ...file, lastSignedWebhookAt: nowIso() } : file);
      await this.identity.revoke(install.id); return;
    }
    const receivedAt = nowIso();
    const session = event.agentSession;
    const eventId = event.action === 'created' ? session.id : event.agentActivity!.id;
    const key = `linear:${install.id}:${event.action}:${eventId}`;
    const knownReceipt = (await this.identity.store.read()).receipts[key];
    let selfDelegated = false;
    let requester: { id: string; name?: string } | undefined;
    // A missing creator also describes automation and other agents. First check
    // exact results from our own proactive creation, including a racing response.
    if (event.action === 'created' && !session.creatorId) {
      const home = this.identity.store.animaHome;
      const starts = (await this.identity.store.read()).sessionStarts;
      for (const [requestId, intent] of Object.entries(starts)) {
        const targetId = intent.target === 'comment' ? session.commentId : session.issueId;
        if (intent.sessionId || intent.rootId !== targetId) continue;
        // The webhook can beat the mutation response. Wait for that writer and
        // then compare IDs, rather than swallowing unrelated work on this target.
        await withFileLock(join(home, 'agents', this.agentId, `linear-start-${requestId}`), home, async () => {});
      }
      const file = await this.identity.store.read();
      if (file.installation?.id !== install.id || file.installation.revoked) throw new Error('Linear identity changed.');
      if (Object.values(file.sessionStarts).some((intent) => intent.sessionId === session.id)) {
        await this.identity.store.update((current) => {
          if (current.installation?.id !== install.id || current.installation.revoked) throw new Error('Linear identity changed.');
          return { ...current, lastSignedWebhookAt: receivedAt };
        });
        return;
      }
      if (!file.receipts[key] && session.issueId) {
        ({ selfDelegated, requester } = await this.sessionOrigin(install, session.id, session.issueId));
      }
    }
    const stopped = event.agentActivity?.signal === 'stop';
    const origin = session.comment?.userId || session.sourceCommentId ? 'mention' : 'delegation';
    let text: string;
    if (event.action === 'prompted') text = event.agentActivity!.body ?? event.agentActivity!.content?.body ?? '';
    else {
      let source: z.infer<typeof SourceComment>['comment'] | undefined;
      if (session.sourceCommentId && !knownReceipt) {
        ({ comment: source } = await this.identity.graphql(install.id,
          'query($id:String!,$app:ID!){comment(id:$id){id issueId body user{id name} parent{id body user{id} children(first:1,filter:{user:{id:{eq:$app}}}){nodes{id}}}}}',
          { id: session.sourceCommentId, app: install.appUserId }, SourceComment));
        if (source.id !== session.sourceCommentId || source.issueId !== session.issueId) throw new Error('Linear session source comment mismatch.');
      }
      if (origin === 'mention') {
        // Linear can copy a child mention into a new session root. Its source
        // comment restores the original thread, without importing other replies.
        const previous = event.previousComments?.find((c) => c.id !== session.commentId);
        const joinedThread = source
          ? source.parent?.user?.id === install.appUserId || Boolean(source.parent?.children.nodes.length)
          : event.previousComments?.some((c) => c.userId === install.appUserId);
        const root = source ? source.parent : previous;
        text = linearCommentText(session.comment?.body ?? source?.body ?? '', joinedThread ? undefined : root);
        if (source?.user) requester = { id: source.user.id, name: source.user.name };
      } else text = 'Read the issue description and comments through anima linear api to get the task.';
      // Guidance has its own structured webhook field, so omitting promptContext
      // does not discard workspace or team instructions.
      const guidance = event.guidance?.map((g) => {
        const label = g.origin?.type === 'Team' ? `Team: ${g.origin.team?.name ?? 'unknown'}` : g.origin?.type ?? 'Linear';
        return `Guidance (${label}):\n${g.body}`;
      });
      text = [text, ...guidance ?? []].filter(Boolean).join('\n\n');
    }
    const item: LinearInboxItem = {
      id: key, kind: 'linear', installationId: install.id, organizationId: install.organizationId,
      sessionId: session.id, action: event.action, text, receivedAt,
      handling: { status: 'queued', createdAt: receivedAt, updatedAt: receivedAt, queuedAt: receivedAt },
    };
    if (event.action === 'prompted') {
      const activity = event.agentActivity!;
      item.activityId = activity.id;
      item.sourceTime = activity.createdAt ?? event.createdAt;
      if (activity.userId ?? activity.user?.id) item.actorId = activity.userId ?? activity.user!.id;
      if (activity.user?.name) item.actorName = activity.user.name;
    } else {
      item.sourceTime = session.createdAt ?? event.createdAt;
      // Linear leaves out the creator when an agent delegated; the opening prompt names it.
      const actorId = requester?.id ?? session.creatorId, actorName = requester?.name ?? session.creator?.name;
      if (actorId) item.actorId = actorId;
      if (actorName) item.actorName = actorName;
      // Every session has a thread. Linear writes the root of a delegated session's thread
      // itself, so that comment has no author; an @mention opens the session in a person's thread.
      item.origin = origin;
    }
    if (session.issueId) item.issueId = session.issueId;
    if (session.issue?.url) item.issueUrl = session.issue.url;
    if (session.issue?.title) item.issueTitle = session.issue.title;
    const issueKey = linearIssueKey(session.issue?.identifier, session.issue?.url);
    if (issueKey) item.issueKey = issueKey;
    // A notification can win delivery before Linear creates/reports a session.
    // Associate the late session with that comment so Stop still reaches it,
    // without enqueueing a second request or inventing a session reply obligation.
    const commentId = session.sourceCommentId ?? session.commentId;
    const commentItemId = commentId && (event.action === 'created' || stopped)
      ? linearCommentItemId(install.id, commentId) : undefined;
    const queue = wakeQueueServiceForAgent(this.agentId);
    const existing = commentItemId ? await queue.find(commentItemId) : undefined;
    const heldComment = event.action === 'created' && !stopped && existing !== undefined && isHeldInboxItem(existing);
    const commentQueued = commentItemId && await queue.has(commentItemId);
    const file = await this.identity.store.update((current) => {
      if (current.installation?.id !== install.id || current.installation.revoked) throw new Error('Linear identity changed.');
      const receipts = { ...current.receipts };
      if (!receipts[key]) {
        const sessionReceipts = Object.values(receipts).filter((r) => r.sessionId === session.id);
        const alreadyStopped = event.action === 'created' && sessionReceipts.some(isStopped);
        // A comment still held as context never reached the agent, so an open session delivers
        // the request itself and takes over disposing of the comment. A stopped session keeps the
        // comment as its request, so Stop settles it. After a takeover, a later Stop links nothing.
        const tookOver = Boolean(commentItemId) && sessionReceipts.some((r) => r.heldCommentItemId === commentItemId);
        const commentDelivered = commentQueued && (heldComment ? alreadyStopped : !tookOver);
        const base = { sessionId: session.id, receivedAt, acknowledgementId: randomUUID(),
          acknowledgement: stopped || alreadyStopped ? 'accepted' as const : 'pending' as const };
        let receipt: LinearReceipt;
        if (stopped) {
          // The Stop is an event of its own; it reaches the session's open work.
          receipt = { ...base, kind: 'stop', state: 'received' };
          for (const [id, r] of Object.entries(receipts)) if (r.sessionId === session.id) receipts[id] = stopReceipt(r);
        } else if (commentDelivered) receipt = { ...base, kind: 'comment', state: alreadyStopped ? 'stopped' : 'linked' };
        else if (selfDelegated) {
          // The caller is already working and reports on the issue. Until the acknowledgement
          // closes the session, its turn can still reply there and a Stop still reaches it.
          receipt = { ...base, kind: 'request', state: alreadyStopped ? 'stopping' : 'awaiting',
            itemId: item.id, runItemId: item.id, selfDelegated: true };
        } else {
          receipt = { ...base, kind: 'request', state: alreadyStopped ? 'stopping' : 'received', itemId: item.id };
          if (!alreadyStopped) receipt.item = item;
          if (heldComment) receipt.heldCommentItemId = commentItemId;
        }
        if (commentDelivered) receipt.commentItemId = commentItemId;
        if (commentId) receipt.commentId = commentId;
        if (item.issueId) receipt.issueId = item.issueId;
        if (item.issueKey) receipt.issueKey = item.issueKey;
        if (item.issueTitle) receipt.issueTitle = item.issueTitle;
        if (item.issueUrl) receipt.issueUrl = item.issueUrl;
        receipts[key] = receipt;
      }
      return { ...current, ...withoutExpiredReceipts(receipts, current.operations, Date.parse(receivedAt)), lastSignedWebhookAt: receivedAt };
    });
    const receipt = file.receipts[key]!;
    if (isStopped(receipt)) { await this.stop(session.id); return; }
    await this.publish(receipt);
    // Withdraw only after the session's request is durable. A failure in between leaves duplicate
    // context rather than a lost request; the webhook retry or a Stop finishes the disposal.
    if (receipt.heldCommentItemId) await queue.withdrawHeld(receipt.heldCommentItemId);
  }

  async assertRunnable(item: LinearInboxItem): Promise<void> {
    const file = await this.identity.store.read();
    const receipt = file.receipts[item.id];
    if (file.installation?.id !== item.installationId || file.installation.revoked
      || !receipt || !isActiveRequest(receipt)) throw new Error('Linear input was stopped, answered or its identity was removed.');
  }

  async markStarted(item: InboxItem, runItemId: string): Promise<void> {
    if (item.kind !== 'linear') return;
    const owner = { installationId: item.installationId, runItemId };
    this.pendingOwners.set(item.id, owner);
    await this.identity.store.update((file) => {
      const receipt = file.receipts[item.id];
      if (!receipt || !isActiveRequest(receipt) || file.installation?.id !== item.installationId) return file;
      return { ...file, receipts: { ...file.receipts, [item.id]: startReceipt(receipt, runItemId) } };
    });
    if (this.pendingOwners.get(item.id) === owner) this.pendingOwners.delete(item.id);
  }

  async markSettled(item: InboxItem): Promise<void> {
    if (item.kind !== 'linear') return;
    // A deferred/restart wake remains queued. It is not a completed turn.
    const queued = await wakeQueueServiceForAgent(this.agentId).find(item.id);
    if (queued && !queued.handling.settledAt) return;
    const owner = this.pendingOwners.get(item.id);
    await this.identity.store.update((file) => {
      const receipt = file.receipts[item.id];
      if (!receipt || file.installation?.id !== item.installationId) return file;
      const settled = endRun(receipt);
      if (owner?.installationId === item.installationId) settled.runItemId = owner.runItemId;
      return { ...file, receipts: { ...file.receipts, [item.id]: settled } };
    });
    if (this.pendingOwners.get(item.id) === owner) this.pendingOwners.delete(item.id);
  }

  async stop(sessionId: string): Promise<void> {
    const file = await this.identity.store.read();
    const queue = wakeQueueServiceForAgent(this.agentId);
    const session = Object.values(file.receipts).filter((r) => r.sessionId === sessionId);
    let activeRun = false;
    let ranBefore = false;
    for (const receipt of session) {
      // A held comment the request replaced must not outlive the Stop, even if the takeover failed midway.
      const replaced = receipt.heldCommentItemId ? await queue.find(receipt.heldCommentItemId) : undefined;
      if (replaced?.handling.status === 'queued') await queue.fail(replaced.id);
      // Stopped work still in the queue or a run: a stopping request, or a comment that carried it.
      const itemId = receipt.state === 'stopping' ? receipt.itemId
        : receipt.commentItemId && isStopped(receipt) && receipt.state !== 'confirmed' ? receipt.commentItemId : undefined;
      if (!itemId) continue;
      const item = await queue.find(itemId);
      const runItemId = receipt.runItemId ?? item?.handling.appendedToItemId ?? item?.id;
      const run = runItemId ? await queue.find(runItemId) : undefined;
      if (run?.handling.status === 'running') { await queue.requestStop(run.id); activeRun = true; }
      else if (item?.handling.status === 'queued') await queue.fail(item.id);
      // A request whose run already ended may have left provider background work.
      else if (receipt.state === 'stopping' && receipt.runItemId) ranBefore = true;
    }
    const pending = session.some((r) => r.state === 'stopping');
    const commentStop = session.some((r) => r.commentItemId && isStopped(r))
      && session.some((r) => r.kind === 'stop' && r.state !== 'confirmed');
    if (commentStop || !activeRun && pending) {
      const body = commentStop
        ? 'Stop requested for this comment-thread request. Earlier actions or provider background work may still exist; check the original comment thread before continuing.'
        : ranBefore
        ? 'Stopped accepting replies for this request. Provider background work may still be running; check it before continuing.'
        : 'Stopped the pending request. Check any earlier actions before continuing.';
      await this.respond(sessionId, 'error', body, undefined, 'stopped');
    }
    await this.identity.store.update((latest) => {
      if (latest.installation?.id !== file.installation?.id) return latest;
      const receipts = { ...latest.receipts };
      for (const [id, r] of Object.entries(receipts)) {
        if (r.sessionId === sessionId && r.kind === 'stop' && r.state === 'received') receipts[id] = { ...r, state: 'applied' };
      }
      return { ...latest, receipts };
    });
  }

  /**
   * The run ended without finishing. Its requests get one failure notice,
   * except `requeuedItemIds`: follow-ups the run never reached, which the worker
   * put back in the queue for the run that picks them up next to answer.
   */
  async finishRun(runItemId: string, body: string, requeuedItemIds: readonly string[] = []): Promise<void> {
    const pending = [...this.pendingOwners].filter(([, owner]) => owner.runItemId === runItemId);
    const notified = (r: LinearReceipt) => r.runItemId === runItemId && claimable(r, 'failed');
    if (!pending.length && !Object.values((await this.identity.store.read()).receipts).some(notified)) return;
    const requeued = new Set(requeuedItemIds);
    const file = await this.identity.store.update((current) => {
      const receipts = { ...current.receipts };
      for (const [id, owner] of pending) {
        if (requeued.has(id)) continue;
        if (current.installation?.id === owner.installationId && receipts[id]) receipts[id] = { ...receipts[id], runItemId: owner.runItemId };
      }
      for (const [id, r] of Object.entries(receipts)) {
        if (r.runItemId === runItemId) receipts[id] = requeued.has(id) && isActiveRequest(r) ? requeueReceipt(r) : endRun(r);
      }
      return { ...current, receipts };
    });
    for (const [id, owner] of pending) if (this.pendingOwners.get(id) === owner) this.pendingOwners.delete(id);
    const sessions = new Set(Object.values(file.receipts).filter(notified).map((r) => r.sessionId));
    const results = await Promise.allSettled([...sessions].map((session) => this.respond(session, 'error', body, runItemId, 'failed')));
    if (results.some((r) => r.status === 'rejected')) throw new Error('Linear run ended; one or more final notices could not be confirmed.');
  }

  async respond(sessionId: string, kind: LinearActivityKind, body: string, runItemId?: string, terminal?: 'stopped' | 'failed'): Promise<SessionReply> {
    return this.sessionLock(sessionId, () => this.respondLocked(sessionId, kind, body, runItemId, terminal));
  }

  private async respondLocked(sessionId: string, kind: LinearActivityKind, body: string, runItemId?: string,
    terminal?: 'stopped' | 'failed',
  ): Promise<SessionReply> {
    const install = await this.knownSession(sessionId, runItemId, !terminal);
    let file = await this.identity.store.read();
    // Resolve earlier unknown effects before a newer input can change the retry key.
    for (const [key, operation] of Object.entries(file.operations)) {
      if (operation.sessionId === sessionId && operation.kind === 'activity' && operation.state !== 'accepted') {
        await this.confirmActivity(install.id, sessionId, operation.id);
        await this.acceptOperation(install.id, key, operation);
      }
    }
    file = await this.identity.store.read();
    // A closing acknowledgement whose result is unknown may already have ended the session.
    // Settle it first, so a reply cannot end the session a second time. When another request
    // waits for this reply, the reply is owed either way and answers the self-delegation too.
    if (!terminal) {
      for (const [key, r] of Object.entries(file.receipts)) {
        if (r.sessionId !== sessionId || !r.selfDelegated || r.state !== 'awaiting') continue;
        if (r.acknowledgement !== 'sending' && r.acknowledgement !== 'unknown') continue;
        const waiting = Object.entries(file.receipts).some(([id, other]) => id !== key && other.sessionId === sessionId && isOpenRequest(other));
        try {
          await this.confirmActivity(install.id, sessionId, r.acknowledgementId);
          await this.setAcknowledgement(install.id, key, 'accepted');
        } catch (error) { if (!waiting) throw error; }
      }
    }
    file = await this.identity.store.read();
    // Receipts outlive their queued items. Reuse the latest known display fields,
    // including when a follow-up omits them, without a per-reply API lookup.
    const issue: Pick<SessionReply, 'issueId' | 'issueKey' | 'issueTitle' | 'issueUrl'> = {};
    for (const receipt of Object.values(file.receipts).filter((r) => r.sessionId === sessionId).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
      for (const field of ['issueId', 'issueKey', 'issueTitle', 'issueUrl'] as const) {
        if (receipt[field]) issue[field] = receipt[field];
      }
    }
    const hash = contentHash(kind, body);
    const candidates = Object.entries(file.receipts).filter(([, r]) => r.sessionId === sessionId && claimable(r, terminal));
    const itemIds: string[] = [];
    for (const [id, receipt] of candidates) {
      const owner = await this.ownerFor(receipt);
      // Once delivered, an unanswered request belongs to the agent's primary
      // session, not just the turn that first handled it. Terminal notices stay
      // scoped to their original run; unstarted inputs cannot be claimed here.
      if (!runItemId || owner === runItemId || (!terminal && receipt.state === 'awaiting' && owner)) itemIds.push(id);
    }
    itemIds.sort();
    if (!itemIds.length) {
      const accepted = Object.values(file.operations).find((op) => op.sessionId === sessionId && op.kind === 'activity'
        && op.state === 'accepted' && op.contentHash === hash && op.ownerRunId === runItemId);
      if (accepted) return { ...issue, activityId: accepted.id, bookkeeping: 'recorded' };
      if (Object.values(file.receipts).some((r) => r.sessionId === sessionId && r.selfDelegated && r.state === 'answered')) {
        throw new Error(`This session came from your own delegation and is closed. Report on the issue instead: reply --to issue:${issue.issueKey ?? '<issue>'}.`);
      }
      throw new Error('No accepted input owned by this run for this Linear session.');
    }
    const key = contentHash(hash, JSON.stringify(itemIds));
    const previous = file.operations[key];
    if (previous?.state === 'accepted') return { ...issue, activityId: previous.id, bookkeeping: 'recorded' };
    const operation: LinearOperation = { id: randomUUID(), sessionId, kind: 'activity', state: 'sending', itemIds, contentHash: hash, activityKind: kind };
    if (runItemId) operation.ownerRunId = runItemId;
    if (terminal) operation.terminal = terminal;
    await this.saveOperation(install.id, key, operation);
    try { await this.createActivity(install.id, sessionId, operation.id, kind, body, false); }
    catch (error) { await this.recordWriteFailure(install.id, key, operation, error); throw error; }
    try { await this.acceptOperation(install.id, key, operation); return { ...issue, activityId: operation.id, bookkeeping: 'recorded' }; }
    catch { return { ...issue, activityId: operation.id, bookkeeping: 'degraded' }; }
  }

  async tick(): Promise<void> {
    const file = await this.identity.store.read();
    if (!file.installation || file.installation.revoked) return;
    const installId = file.installation.id;
    await Promise.all(Object.entries(file.receipts).map(async ([key, receipt]) => {
      if (receipt.kind === 'stop' && receipt.state === 'received') { await this.stop(receipt.sessionId); return; }
      await this.publish(receipt);
      // acknowledge() checks again after taking the session lock.
      if ((receipt.acknowledgement === 'pending' || receipt.acknowledgement === 'sending') && awaitsAcknowledgement(receipt)) {
        await this.acknowledge(key, installId, receipt);
      }
    }));
    // Status covers only a request that is still queued or running. Once its run ends,
    // the runtime sends no further status. Lock only sessions that still have such work.
    const current = await this.identity.store.read();
    const eligible = isActiveRequest;
    const due = (r: LinearReceipt) => Date.now() - Math.max(...[r.lastActivityAt ?? r.receivedAt, r.lastStatusAttemptAt]
      .map((at) => at ? Date.parse(at) : 0)) >= 10 * 60_000;
    const busy = Object.values(current.receipts).filter(eligible);
    for (const sessionId of new Set(busy.map((r) => r.sessionId))) {
      await this.sessionLock(sessionId, async () => {
        const snapshot = await this.identity.store.read();
        if (snapshot.installation?.id !== installId || snapshot.installation.revoked) return;
        const receipts = Object.values(snapshot.receipts).filter((r) => r.sessionId === sessionId && eligible(r));
        if (!receipts.length || !receipts.every(due)) return;
        const queue = wakeQueueServiceForAgent(this.agentId);
        const items = await Promise.all(receipts.map(async (r) => {
          const owner = await this.ownerFor(r);
          return queue.find(owner ?? r.itemId!);
        }));
        const active = items.filter((item) => item && !item.handling.settledAt && ['queued', 'running'].includes(item.handling.status));
        if (!active.length) return;
        await this.updateSessionTimes(installId, sessionId, 'lastStatusAttemptAt');
        const latest = await this.identity.store.read();
        if (latest.installation?.id !== installId || latest.installation.revoked) return;
        if (!receipts.some((r) => Object.values(latest.receipts).some((next) => next.itemId === r.itemId && eligible(next)))) return;
        const body = active.some((item) => item?.handling.status === 'running') ? 'Executing this request.' : 'This request is queued.';
        await this.createActivity(installId, sessionId, randomUUID(), 'thought', body, true);
        await this.updateSessionTimes(installId, sessionId, 'lastActivityAt');
      });
    }
  }

  private async publish(receipt: LinearReceipt): Promise<void> {
    if (receipt.item && receipt.kind === 'request' && receipt.state === 'received') await wakeQueueServiceForAgent(this.agentId).enqueue(receipt.item);
  }

  private async ownerFor(receipt: LinearReceipt): Promise<string | undefined> {
    if (receipt.runItemId) return receipt.runItemId;
    if (!receipt.itemId) return undefined;
    // The worker persists accepted append ownership before its notification hook.
    // Slow notification storage cannot make that accepted input belong to a new run.
    const item = await wakeQueueServiceForAgent(this.agentId).find(receipt.itemId);
    return item?.handling.appendedToItemId ?? (item?.handling.status === 'running' ? item.id : undefined);
  }

  private async acknowledge(key: string, installId: string, receipt: LinearReceipt): Promise<void> {
    await this.sessionLock(receipt.sessionId, async () => {
      const file = await this.identity.store.read();
      const r = file.receipts[key];
      if (file.installation?.id !== installId || file.installation.revoked || !r || !awaitsAcknowledgement(r)) return;
      if (r.acknowledgement === 'sending') {
        try { await this.confirmActivity(installId, r.sessionId, r.acknowledgementId); }
        catch { await this.setAcknowledgement(installId, key, 'unknown'); return; }
      } else if (r.acknowledgement === 'pending') {
        // Without an answer, a self-delegated session stayed open and its timer kept running for days.
        // Linear shows the latest activity as the session's state, so the closing response must not
        // follow another request that still waits for the agent. Then the agent's reply answers both.
        const waiting = Object.entries(file.receipts).some(([id, other]) => id !== key && other.sessionId === r.sessionId && isOpenRequest(other));
        const closes = r.kind === 'request' && r.selfDelegated === true && !waiting;
        await this.setAcknowledgement(installId, key, 'sending', { keepOpen: r.selfDelegated === true && !closes });
        const body = r.kind === 'comment'
          ? 'Received by Anima. This request was already delivered through the original comment thread. Follow that thread for any reply.'
          : closes ? SELF_DELEGATED_BODY : 'Received by Anima.';
        try { await this.createActivity(installId, receipt.sessionId, receipt.acknowledgementId, closes ? 'response' : 'thought', body, !closes); }
        catch {
          // A lost result can hide a response Linear accepted. Confirm it, so no later reply ends the session again.
          const confirmed = closes && await this.confirmActivity(installId, r.sessionId, r.acknowledgementId).then(() => true, () => false);
          if (!confirmed) { await this.setAcknowledgement(installId, key, 'unknown'); return; }
        }
      } else return;
      await this.setAcknowledgement(installId, key, 'accepted');
    });
  }

  /** `keepOpen`: a self-delegation whose session another request still waits in; it stays open like any request. */
  private async setAcknowledgement(installId: string, key: string, state: LinearReceipt['acknowledgement'], { keepOpen = false } = {}): Promise<void> {
    await this.identity.store.update((file) => {
      const r = file.receipts[key];
      if (!r || file.installation?.id !== installId) return file;
      let next: LinearReceipt = { ...r, acknowledgement: state };
      if (keepOpen) delete next.selfDelegated;
      if (state === 'accepted') next.lastActivityAt = nowIso();
      // The acknowledgement of a self-delegation was a response, so it answered the request.
      // A Stop that arrived meanwhile keeps its own notice.
      if (state === 'accepted' && r.selfDelegated && r.state === 'awaiting') next = closeReceipt(next);
      const result = { ...file, receipts: { ...file.receipts, [key]: next } };
      if (state === 'unknown') result.lastError = 'First-activity result is unknown; inspect Linear before sending a new prompt.';
      return result;
    });
  }

  private async updateSessionTimes(installId: string, sessionId: string, field: 'lastActivityAt' | 'lastStatusAttemptAt'): Promise<void> {
    await this.identity.store.update((file) => {
      if (file.installation?.id !== installId || file.installation.revoked) return file;
      const receipts = { ...file.receipts };
      for (const [key, r] of Object.entries(receipts)) if (r.sessionId === sessionId) receipts[key] = { ...r, [field]: nowIso() };
      return { ...file, receipts };
    });
  }

  private async saveOperation(installId: string, key: string, operation: LinearOperation): Promise<void> {
    await this.identity.store.update((file) => {
      if (file.installation?.id !== installId || file.installation.revoked) throw new Error('Linear identity changed.');
      return { ...file, operations: { ...file.operations, [key]: operation } };
    });
  }

  private async recordWriteFailure(installId: string, key: string, operation: LinearOperation, error: unknown): Promise<void> {
    // The write was never sent (its credential could not be obtained), or Linear
    // answered HTTP 401: it was not applied. Release its intent for a later
    // explicit retry. Network, 5xx and partial GraphQL results remain unknown.
    if (!linearRequestNotSent(error) && !(error instanceof LinearApiError && error.status === 401)) {
      await this.saveOperation(installId, key, { ...operation, state: 'unknown' });
      return;
    }
    await this.identity.store.update((file) => {
      if (file.installation?.id !== installId || file.operations[key]?.id !== operation.id
        || file.operations[key]?.state === 'accepted') return file;
      const operations = { ...file.operations };
      delete operations[key];
      return { ...file, operations };
    });
  }

  private async acceptOperation(installId: string, key: string, operation: LinearOperation): Promise<void> {
    await this.identity.store.update((file) => {
      if (file.installation?.id !== installId || file.installation.revoked) throw new Error('Linear identity changed after acceptance.');
      const receipts = { ...file.receipts };
      for (const id of operation.itemIds) {
        const receipt = receipts[id];
        if (!receipt) continue;
        const next = { ...receipt, lastActivityAt: nowIso() };
        receipts[id] = operation.activityKind === 'thought' ? next : closeReceipt(next, operation.terminal);
      }
      return { ...file, receipts, operations: { ...file.operations, [key]: { ...operation, state: 'accepted' } } };
    });
  }

  private async confirmActivity(installId: string, sessionId: string, id: string): Promise<void> {
    const found = await this.identity.graphql(installId, 'query($id:String!){agentActivity(id:$id){id agentSession{id}}}', { id }, ReadActivity)
      .catch(() => { throw new Error('Previous Linear result is unknown; inspect the session before retrying.'); });
    if (found.agentActivity.id !== id || found.agentActivity.agentSession.id !== sessionId) throw new Error('Linear activity session mismatch.');
  }

  private async createActivity(installId: string, sessionId: string, id: string, kind: string, body: string, ephemeral: boolean): Promise<void> {
    const created = await this.identity.graphql(installId, 'mutation($input:AgentActivityCreateInput!){agentActivityCreate(input:$input){success agentActivity{id}}}',
      { input: { id, agentSessionId: sessionId, content: { type: kind, body }, ephemeral } }, Created);
    if (created.agentActivityCreate.agentActivity.id !== id) throw new Error('Linear returned a different activity id; inspect the session.');
  }

  /**
   * Who opened a session Linear reported without a creator. The initial prompt names the
   * actual delegator, which may be this agent itself or another agent. Require creation-time
   * evidence: a later prompt cannot prove who opened it.
   */
  private async sessionOrigin(install: LinearInstallation, sessionId: string, issueId: string): Promise<{ selfDelegated: boolean; requester?: { id: string; name?: string } }> {
    const result = await this.identity.graphql(install.id,
      'query($id:String!){agentSession(id:$id){id appUser{id} creator{id} issue{id} createdAt activities(last:1,orderBy:createdAt){nodes{createdAt promptAuthor{id name} content{... on AgentActivityPromptContent{type}}}}}}',
      { id: sessionId }, SessionOrigin).catch(() => undefined);
    if (!result) return { selfDelegated: false }; // An unavailable origin must never discard new work.
    const session = result.agentSession, first = session.activities.nodes[0];
    const opening = session.id === sessionId && session.appUser.id === install.appUserId && !session.creator
      && session.issue?.id === issueId && first?.content.type === 'prompt' && first.promptAuthor
      && Date.parse(first.createdAt) === Date.parse(session.createdAt);
    if (!opening) return { selfDelegated: false };
    const author = first.promptAuthor!;
    if (author.id === install.appUserId) return { selfDelegated: true };
    return { selfDelegated: false, requester: { id: author.id, ...(author.name ? { name: author.name } : {}) } };
  }

  private async sessionDetails(install: LinearInstallation, sessionId: string): Promise<z.infer<typeof SessionDetails>> {
    const { agentSession } = await this.identity.graphql(install.id,
      `query($id:String!){agentSession(id:$id){${sessionFields}}}`, { id: sessionId }, z.object({ agentSession: SessionDetails }));
    if (agentSession.id !== sessionId || agentSession.appUser.id !== install.appUserId) throw new Error('Linear session does not belong to this app.');
    return agentSession;
  }

  private async registerProactive(installId: string, session: z.infer<typeof SessionDetails>, runItemId?: string): Promise<void> {
    if (session.creator || !['active', 'pending', 'stale'].includes(session.status)) throw new Error('This session is not open proactive work. Use an ordinary comment for further discussion.');
    const key = `linear:${installId}:created:${session.id}`;
    await this.identity.store.update((file) => {
      if (file.installation?.id !== installId || file.installation.revoked) throw new Error('Linear identity changed.');
      // A Stop or prompt can race the creation response. Never replace it.
      if (Object.values(file.receipts).some((r) => r.sessionId === session.id && r.kind === 'stop')) throw new Error('This Linear session was stopped.');
      if (Object.values(file.receipts).some((r) => r.sessionId === session.id)) return file;
      const owner = runItemId ?? key;
      // Opened by the agent's own turn: no run will start for it, so it already awaits the agent's reply.
      const receipt: LinearReceipt = { kind: 'request', state: 'awaiting', sessionId: session.id, receivedAt: nowIso(), itemId: key,
        runItemId: owner, acknowledgement: 'accepted', acknowledgementId: randomUUID() };
      if (session.issue) {
        receipt.issueId = session.issue.id;
        receipt.issueKey = session.issue.identifier;
        receipt.issueTitle = session.issue.title;
        receipt.issueUrl = session.issue.url;
      }
      return { ...file, receipts: { ...file.receipts, [key]: receipt } };
    });
  }

  private async knownSession(sessionId: string, runItemId?: string, adoptProactive = false): Promise<LinearInstallation> {
    const install = await this.identity.authorizedInstallation();
    const file = await this.identity.store.read();
    if (Object.values(file.receipts).some((r) => r.sessionId === sessionId)) return install;
    if (!adoptProactive) throw new Error('Linear session is not authorized for this agent.');
    await this.registerProactive(install.id, await this.sessionDetails(install, sessionId), runItemId);
    return install;
  }
  private sessionLock<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    if (!z.string().uuid().safeParse(sessionId).success) throw new Error('Invalid Linear session id.');
    const home = this.identity.store.animaHome;
    return withFileLock(join(home, 'agents', this.agentId, `linear-session-${sessionId}`), home, op);
  }
}
