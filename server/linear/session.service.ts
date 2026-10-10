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

export class LinearSessionService {
  // Worker hooks are best effort. Keep the actual accepted owner until its journal
  // write succeeds, even when the queue has already removed the settled input.
  private readonly pendingOwners = new Map<string, { installationId: string; runItemId: string }>();
  constructor(readonly identity: LinearIdentityService) {}
  get agentId(): string { return this.identity.agentId; }

  async receive(event: LinearWebhook, install: LinearInstallation): Promise<void> {
    if (event.type === 'OAuthApp') {
      await this.identity.store.update((file) => file.installation?.id === install.id ? { ...file, lastSignedWebhookAt: nowIso() } : file);
      await this.identity.revoke(install.id); return;
    }
    const receivedAt = nowIso();
    const session = event.agentSession;
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
      return { ...current, receipts, lastSignedWebhookAt: receivedAt };
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
      if (receipt.sessionId !== sessionId || !receipt.stopped || !receipt.itemId || receipt.answered || receipt.settled) continue;
      const item = await queue.find(receipt.itemId);
      const runItemId = receipt.runItemId ?? item?.handling.appendedToItemId ?? item?.id;
      const run = runItemId ? await queue.find(runItemId) : undefined;
      if (run?.handling.status === 'running') { await queue.requestStop(run.id); activeRun = true; }
      else if (item?.handling.status === 'queued') await queue.fail(item.id);
    }
    const pending = Object.values(file.receipts).some((r) => r.sessionId === sessionId && r.itemId && r.stopped && !r.answered && !r.settled);
    if (!activeRun && pending) await this.respond(sessionId, 'error', 'Stopped the pending request. Check any earlier actions before continuing.', undefined, 'stopped');
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

  async completeRun(runItemId: string): Promise<void> {
    const item = await wakeQueueServiceForAgent(this.agentId).find(runItemId);
    if (item && !item.handling.settledAt) return;
    await this.finishRun(runItemId, 'The model run ended without a confirmed Linear response. Check progress before sending a new prompt.');
  }

  async read(sessionId: string) {
    const install = await this.knownSession(sessionId);
    const result = await this.identity.graphql(install.id,
      `query($id:String!){agentSession(id:$id){id appUser{id} activities(first:50){nodes{id createdAt content {
        ... on AgentActivityThoughtContent { type body }
        ... on AgentActivityPromptContent { type body }
        ... on AgentActivityResponseContent { type body }
        ... on AgentActivityErrorContent { type body }
        ... on AgentActivityElicitationContent { type body }
        ... on AgentActivityActionContent { type action parameter result }
      }}}}}`, { id: sessionId }, SessionHistory);
    if (result.agentSession.appUser.id !== install.appUserId) throw new Error('Linear session does not belong to this app.');
    return result.agentSession;
  }

  async respond(sessionId: string, kind: LinearActivityKind, body: string, runItemId?: string, terminal?: 'stopped' | 'failed'): Promise<{ activityId: string; bookkeeping: 'recorded' | 'degraded' }> {
    return this.sessionLock(sessionId, async () => {
      const install = await this.knownSession(sessionId);
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
      for (const [id, receipt] of candidates) if (!runItemId || await this.ownerFor(receipt) === runItemId) itemIds.push(id);
      itemIds.sort();
      if (!itemIds.length) {
        const accepted = Object.values(file.operations).find((op) => op.sessionId === sessionId && op.kind === 'activity'
          && op.state === 'accepted' && op.contentHash === hash && op.ownerRunId === runItemId);
        if (accepted) return { activityId: accepted.id, bookkeeping: 'recorded' };
        throw new Error('No accepted input owned by this run for this Linear session.');
      }
      const key = contentHash(hash, JSON.stringify(itemIds));
      const operation: LinearOperation = { id: randomUUID(), sessionId, kind: 'activity', state: 'sending', itemIds, contentHash: hash };
      if (runItemId) operation.ownerRunId = runItemId;
      await this.saveOperation(install.id, key, operation);
      try { await this.createActivity(install.id, sessionId, operation.id, kind, body, false); }
      catch (error) { await this.saveOperation(install.id, key, { ...operation, state: 'unknown' }); throw error; }
      try { await this.acceptOperation(install.id, key, operation); return { activityId: operation.id, bookkeeping: 'recorded' }; }
      catch { return { activityId: operation.id, bookkeeping: 'degraded' }; }
    });
  }

  async attach(sessionId: string, url: string, runItemId?: string): Promise<{ bookkeeping: 'recorded' | 'degraded' }> {
    return this.sessionLock(sessionId, async () => {
      const install = await this.knownSession(sessionId);
      const receipts = Object.values((await this.identity.store.read()).receipts);
      let authorized = false;
      for (const receipt of receipts) if (receipt.sessionId === sessionId && receipt.itemId && !receipt.stopped
        && (!runItemId || await this.ownerFor(receipt) === runItemId)) authorized = true;
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
      } catch (error) { await this.saveOperation(install.id, key, { ...operation, state: 'unknown' }); throw error; }
      try { await this.saveOperation(install.id, key, { ...operation, state: 'accepted' }); return { bookkeeping: 'recorded' }; }
      catch { return { bookkeeping: 'degraded' }; }
    });
  }

  async tick(): Promise<void> {
    const file = await this.identity.store.read();
    if (!file.installation || file.installation.revoked) return;
    const installId = file.installation.id;
    await Promise.all(Object.entries(file.receipts).map(async ([key, receipt]) => {
      if (receipt.stopSignal && !receipt.settled) { await this.stop(receipt.sessionId); return; }
      await this.publish(receipt);
      if (receipt.acknowledgement === 'pending' || receipt.acknowledgement === 'sending') await this.acknowledge(key, installId, receipt);
    }));
    const current = await this.identity.store.read();
    for (const sessionId of new Set(Object.values(current.receipts).map((r) => r.sessionId))) {
      await this.sessionLock(sessionId, async () => {
        const snapshot = await this.identity.store.read();
        if (snapshot.installation?.id !== installId || snapshot.installation.revoked) return;
        const receipts = Object.values(snapshot.receipts).filter((r) => r.sessionId === sessionId && !r.stopped && !r.answered && !r.settled && r.itemId);
        if (!receipts.length) return;
        const last = receipts.map((r) => r.lastStatusAttemptAt ?? r.lastActivityAt ?? r.receivedAt).sort().at(-1)!;
        if (Date.now() - Date.parse(last) < 10 * 60_000) return;
        const queue = wakeQueueServiceForAgent(this.agentId);
        const items = await Promise.all(receipts.map(async (r) => {
          const owner = await this.ownerFor(r);
          return queue.find(owner ?? r.itemId!);
        }));
        const active = items.filter((item) => item && !item.handling.settledAt && ['queued', 'running'].includes(item.handling.status));
        if (!active.length) return;
        await this.updateSessionTimes(installId, sessionId, 'lastStatusAttemptAt');
        const latest = await this.identity.store.read();
        if (!receipts.some((r) => r.itemId && Object.values(latest.receipts).some((next) => next.itemId === r.itemId && !next.stopped && !next.answered && !next.settled))) return;
        const body = active.some((item) => item?.handling.status === 'running') ? 'Executing this request.' : 'This request is queued.';
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

  private async acceptOperation(installId: string, key: string, operation: LinearOperation): Promise<void> {
    await this.identity.store.update((file) => {
      if (file.installation?.id !== installId || file.installation.revoked) throw new Error('Linear identity changed after acceptance.');
      const receipts = { ...file.receipts };
      for (const id of operation.itemIds) if (receipts[id]) receipts[id] = { ...receipts[id]!, answered: true, item: undefined, lastActivityAt: nowIso() };
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

  private async knownSession(sessionId: string): Promise<LinearInstallation> {
    const file = await this.identity.store.read();
    if (!file.installation || file.installation.revoked || !Object.values(file.receipts).some((r) => r.sessionId === sessionId)) throw new Error('Linear session is not authorized for this agent.');
    return file.installation;
  }
  private sessionLock<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    if (!z.string().uuid().safeParse(sessionId).success) throw new Error('Invalid Linear session id.');
    const home = this.identity.store.animaHome;
    return withFileLock(join(home, 'agents', this.agentId, `linear-session-${sessionId}`), home, op);
  }
}
