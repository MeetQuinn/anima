import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { LinearActivityKind } from '../../shared/linear.js';
import type { LinearInboxItem, InboxItem } from '../../shared/inbox.js';
import { nowIso } from '../ids.js';
import { wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import { withFileLock } from '../storage/lock.js';
import type { LinearInstallation, LinearOperation, LinearReceipt } from '../storage/schema/linear.store.js';
import { LinearIdentityService } from './identity.service.js';
import { LinearApiError } from './client.js';
import type { LinearWebhook } from './webhook.js';

const Created = z.object({ agentActivityCreate: z.object({ success: z.literal(true), agentActivity: z.object({ id: z.string() }) }) });
const ReadActivity = z.object({ agentActivity: z.object({ id: z.string(), agentSession: z.object({ id: z.string() }) }) });
const Updated = z.object({ agentSessionUpdate: z.object({ success: z.literal(true) }) });
const SessionHistory = z.object({ agentSession: z.object({ id: z.string(), appUser: z.object({ id: z.string() }),
  activities: z.object({ nodes: z.array(z.object({ id: z.string(), content: z.unknown(), createdAt: z.string() })) }),
}) });
const Links = z.object({ agentSession: z.object({ appUser: z.object({ id: z.string() }), externalLinks: z.array(z.object({ url: z.string() })) }) });
const Issue = z.object({ issue: z.object({ id: z.string(), delegate: z.object({ id: z.string() }).nullable(),
  state: z.object({ type: z.string() }), team: z.object({ states: z.object({ nodes: z.array(z.object({ id: z.string(), type: z.string(), position: z.number() })) }) }),
}) });
const IssueUpdated = z.object({ issueUpdate: z.object({ success: z.literal(true) }) });
const contentHash = (kind: string, body: string) => createHash('sha256').update(JSON.stringify([kind, body])).digest('hex');
const sessionFields = 'id appUser{id} creator{id} issue{id} comment{id} status url';
const SessionDetails = z.object({ id: z.string().uuid(), appUser: z.object({ id: z.string() }),
  creator: z.object({ id: z.string() }).nullable(), issue: z.object({ id: z.string() }).nullable(),
  comment: z.object({ id: z.string() }).nullable(), status: z.string(), url: z.string().url().nullable(),
});

// Linear retries a delivery for at most a few hours, so a finished receipt has done its
// deduplication long before 30 days. Without a limit, linear.json kept every receipt
// of every session ever seen.
const FINISHED_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Drops receipts finished more than 30 days ago, then operations whose session has no receipt left. */
function withoutExpiredReceipts(receipts: Record<string, LinearReceipt>, operations: Record<string, LinearOperation>, now: number) {
  const cutoff = now - FINISHED_RECEIPT_RETENTION_MS;
  const kept = Object.fromEntries(Object.entries(receipts).filter(([, r]) => {
    // Queue settlement can leave a background request unanswered.
    if (!r.answered && !r.stopped) return true;
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
    if (event.type === 'OAuthApp') {
      await this.identity.store.update((file) => file.installation?.id === install.id ? { ...file, lastSignedWebhookAt: nowIso() } : file);
      await this.identity.revoke(install.id); return;
    }
    const receivedAt = nowIso();
    const session = event.agentSession;
    // Null creators also describe automation and other agents. Only an exact
    // result from our own create operation identifies an already-running caller.
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
    }
    const eventId = event.action === 'created' ? session.id : event.agentActivity!.id;
    const key = `linear:${install.id}:${event.action}:${eventId}`;
    const stopped = event.agentActivity?.signal === 'stop';
    const text = event.action === 'prompted' ? event.agentActivity!.body ?? event.agentActivity!.content?.body ?? ''
      : event.promptContext ?? [session.issue?.title, session.issue?.description, session.comment?.body, ...(event.guidance?.map((g) => g.body) ?? [])].filter(Boolean).join('\n\n');
    const item: LinearInboxItem = {
      id: key, kind: 'linear', installationId: install.id, organizationId: install.organizationId,
      sessionId: session.id, text: text ?? '', receivedAt, humanRequested: Boolean(session.creatorId),
      handling: { status: 'queued', createdAt: receivedAt, updatedAt: receivedAt, queuedAt: receivedAt },
    };
    if (session.issueId) item.issueId = session.issueId;
    if (session.issue?.url) item.issueUrl = session.issue.url;
    if (session.creator?.name) item.actorName = session.creator.name;
    const file = await this.identity.store.update((current) => {
      if (current.installation?.id !== install.id || current.installation.revoked) throw new Error('Linear identity changed.');
      const receipts = { ...current.receipts };
      if (!receipts[key]) {
        receipts[key] = { sessionId: session.id, receivedAt, acknowledgement: stopped ? 'accepted' : 'pending', acknowledgementId: randomUUID() };
        if (stopped) {
          receipts[key].stopped = true;
          receipts[key].stopSignal = true;
          for (const [id, r] of Object.entries(receipts)) if (r.sessionId === session.id) receipts[id] = { ...r, stopped: true };
        }
        else { receipts[key].itemId = item.id; receipts[key].item = item; }
        if (item.issueId) receipts[key].issueId = item.issueId;
      }
      return { ...current, ...withoutExpiredReceipts(receipts, current.operations, Date.parse(receivedAt)), lastSignedWebhookAt: receivedAt };
    });
    if (stopped) { await this.stop(session.id); return; }
    await this.publish(file.receipts[key]!);
  }

  async assertRunnable(item: LinearInboxItem): Promise<void> {
    const file = await this.identity.store.read();
    const receipt = file.receipts[item.id];
    if (file.installation?.id !== item.installationId || file.installation.revoked
      || !receipt || receipt.stopped || receipt.answered || receipt.settled) throw new Error('Linear input was stopped, answered or its identity was removed.');
  }

  async markStarted(item: InboxItem, runItemId: string): Promise<void> {
    if (item.kind !== 'linear') return;
    const owner = { installationId: item.installationId, runItemId };
    this.pendingOwners.set(item.id, owner);
    const startedFile = await this.identity.store.update((file) => {
      const receipt = file.receipts[item.id];
      if (!receipt || receipt.stopped || file.installation?.id !== item.installationId) return file;
      return { ...file, receipts: { ...file.receipts, [item.id]: { ...receipt, runItemId } } };
    });
    if (this.pendingOwners.get(item.id) === owner) this.pendingOwners.delete(item.id);
    if (startedFile.receipts[item.id]?.stopped || startedFile.receipts[item.id]?.runItemId !== runItemId) return;
    if (item.issueId && item.humanRequested) {
      const result = await this.identity.graphql(item.installationId,
        'query($id:String!){ issue(id:$id){ id delegate { id } state { type } team { states { nodes { id type position } } } } }', { id: item.issueId }, Issue);
      const issue = result.issue;
      const install = (await this.identity.store.read()).installation;
      if (issue.delegate?.id !== install?.appUserId || ['started', 'completed', 'canceled'].includes(issue.state.type)) return;
      const started = issue.team.states.nodes.filter((state) => state.type === 'started').sort((a, b) => a.position - b.position)[0];
      if (started && !(await this.identity.store.read()).receipts[item.id]?.stopped) await this.identity.graphql(item.installationId, 'mutation($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success}}',
        { id: item.issueId, input: { stateId: started.id } }, IssueUpdated);
    }
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
      const settled = { ...receipt, settled: true, item: undefined };
      if (owner?.installationId === item.installationId) settled.runItemId = owner.runItemId;
      return { ...file, receipts: { ...file.receipts, [item.id]: settled } };
    });
    if (this.pendingOwners.get(item.id) === owner) this.pendingOwners.delete(item.id);
  }

  async stop(sessionId: string): Promise<void> {
    const file = await this.identity.store.read();
    const queue = wakeQueueServiceForAgent(this.agentId);
    let activeRun = false;
    for (const receipt of Object.values(file.receipts)) {
      if (receipt.sessionId !== sessionId || !receipt.stopped || !receipt.itemId || receipt.answered) continue;
      const item = await queue.find(receipt.itemId);
      const runItemId = receipt.runItemId ?? item?.handling.appendedToItemId ?? item?.id;
      const run = runItemId ? await queue.find(runItemId) : undefined;
      if (run?.handling.status === 'running') { await queue.requestStop(run.id); activeRun = true; }
      else if (item?.handling.status === 'queued') await queue.fail(item.id);
    }
    const pending = Object.values(file.receipts).some((r) => r.sessionId === sessionId && r.itemId && r.stopped && !r.answered);
    if (!activeRun && pending) {
      const background = Object.values(file.receipts).some((r) => r.sessionId === sessionId && r.stopped && r.settled && !r.answered);
      const body = background
        ? 'Stopped accepting replies for this request. Provider background work may still be running; check it before continuing.'
        : 'Stopped the pending request. Check any earlier actions before continuing.';
      await this.respond(sessionId, 'error', body, undefined, 'stopped');
    }
    await this.identity.store.update((latest) => {
      if (latest.installation?.id !== file.installation?.id) return latest;
      const receipts = { ...latest.receipts };
      for (const [id, r] of Object.entries(receipts)) if (r.sessionId === sessionId && r.stopSignal) receipts[id] = { ...r, settled: true };
      return { ...latest, receipts };
    });
  }

  async finishRun(runItemId: string, body: string): Promise<void> {
    const pending = [...this.pendingOwners].filter(([, owner]) => owner.runItemId === runItemId);
    if (!pending.length && !Object.values((await this.identity.store.read()).receipts).some((r) => r.runItemId === runItemId && !r.answered)) return;
    const file = await this.identity.store.update((current) => {
      const receipts = { ...current.receipts };
      for (const [id, owner] of pending) {
        if (current.installation?.id === owner.installationId && receipts[id]) receipts[id] = { ...receipts[id], runItemId: owner.runItemId };
      }
      for (const [id, r] of Object.entries(receipts)) if (r.runItemId === runItemId) receipts[id] = { ...r, settled: true, item: undefined };
      return { ...current, receipts };
    });
    for (const [id, owner] of pending) if (this.pendingOwners.get(id) === owner) this.pendingOwners.delete(id);
    const sessions = new Set(Object.values(file.receipts).filter((r) => r.runItemId === runItemId && !r.answered).map((r) => r.sessionId));
    const results = await Promise.allSettled([...sessions].map((session) => this.respond(session, 'error', body, runItemId, 'failed')));
    if (results.some((r) => r.status === 'rejected')) throw new Error('Linear run ended; one or more final notices could not be confirmed.');
  }

  async completeIdleRuns(isIdle: () => Promise<boolean>): Promise<void> {
    const file = await this.identity.store.read();
    if (!file.installation || file.installation.revoked) return;
    const installId = file.installation.id;
    const pending = Object.values(file.receipts).filter((r) => r.settled && r.runItemId && !r.answered && !r.stopped && !r.idleCompletionFailed);
    if (!pending.length || !await isIdle()) return;
    for (const sessionId of new Set(pending.map((r) => r.sessionId))) {
      await this.sessionLock(sessionId, async () => {
        const latest = await this.identity.store.read();
        if (latest.installation?.id !== installId || latest.installation.revoked) return;
        const owners = new Set(Object.values(latest.receipts)
          .filter((r) => r.sessionId === sessionId && r.settled && !r.answered && !r.stopped && !r.idleCompletionFailed)
          .flatMap((r) => r.runItemId ? [r.runItemId] : []));
        for (const owner of owners) {
          try {
            const result = await this.respondLocked(sessionId, 'error',
              'The model run ended without a confirmed Linear response. Check progress before sending a new prompt.',
              owner, 'failed', isIdle);
            if (result?.bookkeeping !== 'degraded') continue;
          } catch { /* Record a bounded failure below; other owners/sessions still finish. */ }
          // Do not turn an uncertain send into a query every 15 seconds. Persist the
          // failure for this owner, including across restarts. Explicit responses
          // still reconcile the operation before sending anything else.
          await this.identity.store.update((current) => {
            if (current.installation?.id !== installId || current.installation.revoked) return current;
            const receipts = { ...current.receipts };
            let failed = false;
            for (const [key, r] of Object.entries(receipts)) {
              if (r.sessionId !== sessionId || r.runItemId !== owner || r.answered || r.stopped) continue;
              receipts[key] = { ...r, idleCompletionFailed: true }; failed = true;
            }
            return failed ? { ...current, receipts,
              lastError: 'A final Linear notice could not be confirmed. Automatic retry stopped; inspect the session before responding.' } : current;
          });
        }
      });
    }
  }

  async read(sessionId: string) {
    const install = await this.identity.authorizedInstallation();
    const result = await this.identity.graphql(install.id,
      `query($id:String!){agentSession(id:$id){id appUser{id} activities(first:50){nodes{id createdAt content {
        ... on AgentActivityThoughtContent { type body }
        ... on AgentActivityPromptContent { type body }
        ... on AgentActivityResponseContent { type body }
        ... on AgentActivityErrorContent { type body }
        ... on AgentActivityElicitationContent { type body }
        ... on AgentActivityActionContent { type action parameter result }
      }}}}}`, { id: sessionId }, SessionHistory);
    if (result.agentSession.id !== sessionId || result.agentSession.appUser.id !== install.appUserId) throw new Error('Linear session does not belong to this app.');
    return result.agentSession;
  }

  async respond(sessionId: string, kind: LinearActivityKind, body: string, runItemId?: string, terminal?: 'stopped' | 'failed'): Promise<{ activityId: string; bookkeeping: 'recorded' | 'degraded' }> {
    return this.sessionLock(sessionId, async () => (await this.respondLocked(sessionId, kind, body, runItemId, terminal))!);
  }

  private async respondLocked(sessionId: string, kind: LinearActivityKind, body: string, runItemId?: string,
    terminal?: 'stopped' | 'failed', isIdle?: () => Promise<boolean>,
  ): Promise<{ activityId: string; bookkeeping: 'recorded' | 'degraded' } | undefined> {
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
    const hash = contentHash(kind, body);
    const candidates = Object.entries(file.receipts).filter(([, r]) => r.sessionId === sessionId
      && r.itemId && !r.answered && (terminal === 'stopped' ? r.stopped : terminal === 'failed' || !r.stopped));
    const itemIds: string[] = [];
    for (const [id, receipt] of candidates) {
      const owner = await this.ownerFor(receipt);
      // Once delivered, an unanswered request belongs to the agent's primary
      // session, not just the turn that first handled it. Terminal notices stay
      // scoped to their original run; unstarted inputs cannot be claimed here.
      if (!runItemId || owner === runItemId || (!terminal && receipt.settled && owner)) itemIds.push(id);
    }
    itemIds.sort();
    if (!itemIds.length) {
      const accepted = Object.values(file.operations).find((op) => op.sessionId === sessionId && op.kind === 'activity'
        && op.state === 'accepted' && op.contentHash === hash && op.ownerRunId === runItemId);
      if (accepted) return { activityId: accepted.id, bookkeeping: 'recorded' };
      throw new Error('No accepted input owned by this run for this Linear session.');
    }
    const key = contentHash(hash, JSON.stringify(itemIds));
    const previous = file.operations[key];
    if (previous?.state === 'accepted') return { activityId: previous.id, bookkeeping: 'recorded' };
    if (isIdle && !await isIdle()) return;
    const operation: LinearOperation = { id: randomUUID(), sessionId, kind: 'activity', state: 'sending', itemIds, contentHash: hash, activityKind: kind };
    if (runItemId) operation.ownerRunId = runItemId;
    await this.saveOperation(install.id, key, operation);
    try { await this.createActivity(install.id, sessionId, operation.id, kind, body, false); }
    catch (error) { await this.recordWriteFailure(install.id, key, operation, error); throw error; }
    try { await this.acceptOperation(install.id, key, operation); return { activityId: operation.id, bookkeeping: 'recorded' }; }
    catch { return { activityId: operation.id, bookkeeping: 'degraded' }; }
  }

  async attach(sessionId: string, url: string, runItemId?: string): Promise<{ bookkeeping: 'recorded' | 'degraded' }> {
    return this.sessionLock(sessionId, async () => {
      const install = await this.knownSession(sessionId, runItemId, true);
      const receipts = Object.values((await this.identity.store.read()).receipts);
      let authorized = false;
      for (const receipt of receipts) {
        if (receipt.sessionId !== sessionId || !receipt.itemId || receipt.stopped) continue;
        const owner = await this.ownerFor(receipt);
        if (!runItemId || owner === runItemId || (receipt.settled && !receipt.answered && owner)) authorized = true;
      }
      if (!authorized) throw new Error('No authorized input for this link.');
      const key = contentHash('link', JSON.stringify([sessionId, url]));
      const previous = (await this.identity.store.read()).operations[key];
      if (previous?.state === 'accepted') return { bookkeeping: 'recorded' };
      if (previous) {
        const links = await this.identity.graphql(install.id, 'query($id:String!){agentSession(id:$id){appUser{id} externalLinks{url}}}', { id: sessionId }, Links);
        if (links.agentSession.appUser.id !== install.appUserId || !links.agentSession.externalLinks.some((link) => link.url === url)) {
          throw new Error('Previous link result is unknown; inspect Linear before retrying.');
        }
        await this.saveOperation(install.id, key, { ...previous, state: 'accepted' });
        return { bookkeeping: 'recorded' };
      }
      const operation: LinearOperation = { id: randomUUID(), sessionId, kind: 'link', state: 'sending', itemIds: [], contentHash: key, url };
      await this.saveOperation(install.id, key, operation);
      try {
        await this.identity.graphql(install.id, 'mutation($id:String!,$input:AgentSessionUpdateInput!){agentSessionUpdate(id:$id,input:$input){success}}',
          { id: sessionId, input: { addedExternalUrls: [{ url, label: 'Pull request' }] } }, Updated);
      } catch (error) { await this.recordWriteFailure(install.id, key, operation, error); throw error; }
      try { await this.saveOperation(install.id, key, { ...operation, state: 'accepted' }); return { bookkeeping: 'recorded' }; }
      catch { return { bookkeeping: 'degraded' }; }
    });
  }

  async tick(hasOngoingWork?: () => Promise<boolean>): Promise<void> {
    const file = await this.identity.store.read();
    if (!file.installation || file.installation.revoked) return;
    const installId = file.installation.id;
    await Promise.all(Object.entries(file.receipts).map(async ([key, receipt]) => {
      if (receipt.stopSignal && !receipt.settled) { await this.stop(receipt.sessionId); return; }
      await this.publish(receipt);
      // acknowledge() skips a stopped or answered receipt, but only after taking its lock.
      if ((receipt.acknowledgement === 'pending' || receipt.acknowledgement === 'sending') && !receipt.stopped && !receipt.answered) {
        await this.acknowledge(key, installId, receipt);
      }
    }));
    // Lock only sessions that still have work. Locking every session each second cost a
    // file lock per session ever seen; the lock re-checks the receipts it reads.
    const current = await this.identity.store.read();
    const eligible = (r: LinearReceipt) => r.itemId && !r.stopped && !r.answered && !r.idleCompletionFailed
      && (!r.settled || (hasOngoingWork && r.runItemId));
    const due = (r: LinearReceipt) => Date.now() - Math.max(...[r.lastActivityAt ?? r.receivedAt, r.lastStatusAttemptAt]
      .map((at) => at ? Date.parse(at) : 0)) >= 10 * 60_000;
    const candidates = Object.values(current.receipts).filter((r) => eligible(r) && (!r.settled || due(r)));
    // An idle/offline agent may have many unanswered sessions. Check shared work
    // once before taking their locks, then recheck before any actual status send.
    const sharedWork = candidates.some((r) => r.settled) && await hasOngoingWork?.();
    const busy = candidates.filter((r) => !r.settled || sharedWork);
    for (const sessionId of new Set(busy.map((r) => r.sessionId))) {
      await this.sessionLock(sessionId, async () => {
        const snapshot = await this.identity.store.read();
        if (snapshot.installation?.id !== installId || snapshot.installation.revoked) return;
        const receipts = Object.values(snapshot.receipts).filter((r) => r.sessionId === sessionId && eligible(r));
        if (!receipts.length || !receipts.every(due)) return;
        const queue = wakeQueueServiceForAgent(this.agentId);
        const items = await Promise.all(receipts.filter((r) => !r.settled).map(async (r) => {
          const owner = await this.ownerFor(r);
          return queue.find(owner ?? r.itemId!);
        }));
        const active = items.filter((item) => item && !item.handling.settledAt && ['queued', 'running'].includes(item.handling.status));
        const ongoing = !active.length && receipts.some((r) => r.settled) && await hasOngoingWork?.();
        if (!active.length && !ongoing) return;
        await this.updateSessionTimes(installId, sessionId, 'lastStatusAttemptAt');
        const latest = await this.identity.store.read();
        if (latest.installation?.id !== installId || latest.installation.revoked) return;
        if (!receipts.some((r) => Object.values(latest.receipts).some((next) => next.itemId === r.itemId && eligible(next) && (ongoing || !next.settled)))) return;
        // Provider work belongs to the shared primary session. Do not claim that
        // an unrelated background task is making progress on this request.
        const body = ongoing ? 'The agent still has ongoing work. This request is waiting for a final response.'
          : active.some((item) => item?.handling.status === 'running') ? 'Executing this request.' : 'This request is queued.';
        await this.createActivity(installId, sessionId, randomUUID(), 'thought', body, true);
        await this.updateSessionTimes(installId, sessionId, 'lastActivityAt');
      });
    }
  }

  private async publish(receipt: LinearReceipt): Promise<void> {
    if (receipt.item && !receipt.stopped && !receipt.settled && !receipt.answered) await wakeQueueServiceForAgent(this.agentId).enqueue(receipt.item);
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
      if (file.installation?.id !== installId || file.installation.revoked || !r || r.stopped || r.answered) return;
      if (r.acknowledgement === 'sending') {
        try { await this.confirmActivity(installId, r.sessionId, r.acknowledgementId); }
        catch { await this.setAcknowledgement(installId, key, 'unknown'); return; }
      } else if (r.acknowledgement === 'pending') {
        await this.setAcknowledgement(installId, key, 'sending');
        try { await this.createActivity(installId, receipt.sessionId, receipt.acknowledgementId, 'thought', 'Received by Anima.', true); }
        catch { await this.setAcknowledgement(installId, key, 'unknown'); return; }
      } else return;
      await this.setAcknowledgement(installId, key, 'accepted');
    });
  }

  private async setAcknowledgement(installId: string, key: string, state: LinearReceipt['acknowledgement']): Promise<void> {
    await this.identity.store.update((file) => {
      const r = file.receipts[key];
      if (!r || file.installation?.id !== installId) return file;
      const next = { ...r, acknowledgement: state };
      if (state === 'accepted') next.lastActivityAt = nowIso();
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
    if (!(error instanceof LinearApiError) || error.status !== 401) {
      await this.saveOperation(installId, key, { ...operation, state: 'unknown' });
      return;
    }
    // HTTP 401 confirms this write was not applied. Release its intent for a
    // later explicit retry; network/5xx/partial GraphQL results remain unknown.
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
        if (operation.activityKind !== 'thought') { next.answered = true; next.item = undefined; }
        receipts[id] = next;
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
      if (Object.values(file.receipts).some((r) => r.sessionId === session.id && r.stopSignal)) throw new Error('This Linear session was stopped.');
      if (Object.values(file.receipts).some((r) => r.sessionId === session.id)) return file;
      const owner = runItemId ?? key;
      const receipt: LinearReceipt = { sessionId: session.id, receivedAt: nowIso(), itemId: key, runItemId: owner,
        settled: true, acknowledgement: 'accepted', acknowledgementId: randomUUID() };
      if (session.issue) receipt.issueId = session.issue.id;
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
