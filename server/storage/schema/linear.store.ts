import { LinearInboxItem } from '../../../shared/inbox.js';
import { LinearActivityKind } from '../../../shared/linear.js';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveAnimaHome } from '../../anima-home.js';
import { JsonStore } from '../json-store.js';
import { AGENT_ID } from './agent.store.js';

const Installation = z.object({
  id: z.string(), clientId: z.string(), signingSecret: z.string(),
  // Optional: installations made before Linear required it have none.
  clientSecret: z.string().optional(),
  // Linear answered invalid_client on refresh; tokens are kept.
  clientRejected: z.boolean().optional(),
  organizationId: z.string(), appUserId: z.string(), accessToken: z.string(),
  workspaceName: z.string().trim().min(1).max(256).optional(),
  // The app user's display name in Linear; installations made before it was recorded have none.
  appName: z.string().trim().min(1).max(256).optional(),
  // Reuse private assets for identical file replies so session retry hashes stay stable.
  uploadedFiles: z.record(z.string(), z.string().url()).optional(),
  refreshToken: z.string(), expiresAt: z.number(), revoked: z.boolean(),
});
export type LinearInstallation = z.infer<typeof Installation>;
const PendingOAuth = z.object({
  id: z.string(), clientId: z.string(), signingSecret: z.string(), clientSecret: z.string().optional(),
  callbackUrl: z.string(), returnUrl: z.string().url().optional(), verifier: z.string(), binding: z.string(), expiresAt: z.number(),
});
/**
 * A receipt records one Linear session event and where it stands.
 * - request: Anima delivered it to the agent. received → running → awaiting (its run ended
 *   without a reply; a later turn can still answer) → answered, or failed when only the
 *   runtime's failure notice closed it. A Stop moves an open request to stopping until a
 *   terminal notice covers it, then stopped. Finished requests keep their outcome.
 * - comment: the request already came through its comment thread, so there is no session
 *   reply obligation. linked → stopped; Stop still reaches the comment's work.
 * - stop: a Stop signal, the event itself. received → applied once its work is disposed of,
 *   or confirmed once a Stop notice covering it was accepted.
 */
export const LinearReceiptKind = z.enum(['request', 'comment', 'stop']);
export const LinearReceiptState = z.enum([
  'received', 'running', 'awaiting', 'answered', 'failed', 'stopping', 'stopped', 'linked', 'applied', 'confirmed',
]);

// Receipts written before explicit states carried boolean flags.
function migrateReceipt(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || 'state' in raw) return raw;
  const { stopped, stopSignal, settled, answered, ...rest } = raw as Record<string, unknown>;
  if (stopSignal) return { ...rest, kind: 'stop', state: answered ? 'confirmed' : settled ? 'applied' : 'received' };
  if (!rest.itemId) return { ...rest, kind: 'comment', state: stopped ? 'stopped' : 'linked' };
  const state = stopped ? answered ? 'stopped' : 'stopping'
    : answered ? 'answered' : settled ? 'awaiting' : rest.runItemId ? 'running' : 'received';
  return { ...rest, kind: 'request', state };
}

const Receipt = z.preprocess(migrateReceipt, z.object({
  kind: LinearReceiptKind,
  state: LinearReceiptState,
  // The request to publish while it is received; dropped once it no longer needs delivery.
  item: LinearInboxItem.optional(),
  sessionId: z.string(), issueId: z.string().optional(), receivedAt: z.string(),
  issueKey: z.string().optional(), issueTitle: z.string().optional(), issueUrl: z.string().optional(),
  commentId: z.string().optional(),
  // A comment notification already delivered this request before its session
  // arrived. Keep the association for Stop, without a second reply obligation.
  commentItemId: z.string().optional(),
  // A held comment notification this session request replaced. The receipt keeps the
  // duty to dispose of it: withdrawn once the request is published, settled by Stop.
  heldCommentItemId: z.string().optional(),
  itemId: z.string().optional(), runItemId: z.string().optional(),
  acknowledgement: z.enum(['pending', 'sending', 'accepted', 'unknown']),
  acknowledgementId: z.string(),
  lastActivityAt: z.string().optional(),
  lastStatusAttemptAt: z.string().optional(),
}));
export type LinearReceipt = z.infer<typeof Receipt>;
// Keep persisted link intents readable for inspection and normal receipt pruning.
// New external-link writes use the generic API and do not create these intents.
const Operation = z.object({
  id: z.string(), sessionId: z.string(), kind: z.enum(['activity', 'link']),
  state: z.enum(['sending', 'accepted', 'unknown']), itemIds: z.array(z.string()),
  contentHash: z.string(), ownerRunId: z.string().optional(), url: z.string().optional(),
  // Older activity operations were all terminal responses.
  activityKind: LinearActivityKind.optional(),
  // A runtime notice: Stop confirmation or run failure. Absent for the agent's own replies.
  terminal: z.enum(['stopped', 'failed']).optional(),
});
export type LinearOperation = z.infer<typeof Operation>;
const LinearFile = z.object({
  installation: Installation.optional(),
  pending: PendingOAuth.optional(),
  receipts: z.record(z.string(), Receipt).default({}),
  operations: z.record(z.string(), Operation).default({}),
  // Linear assigns session IDs. An intent without a result must not be resent.
  sessionStarts: z.record(z.string(), z.object({
    target: z.enum(['issue', 'comment']), targetId: z.string(), rootId: z.string().uuid(), createdAt: z.string(),
    sessionId: z.string().optional(),
  })).default({}),
  lastSignedWebhookAt: z.string().optional(),
  lastError: z.string().optional(),
});
type LinearFile = z.infer<typeof LinearFile>;

export class LinearStore {
  private readonly file: JsonStore<LinearFile>;
  constructor(agentId: string, readonly animaHome = resolveAnimaHome()) {
    if (!AGENT_ID.test(agentId) || agentId === '.' || agentId === '..') throw new Error('Invalid agent id');
    this.file = new JsonStore({
      path: () => join(animaHome, 'agents', agentId, 'linear.json'),
      writeRoot: () => animaHome,
      mode: 0o600,
      empty: () => ({ receipts: {}, operations: {}, sessionStarts: {} }),
      parse: (value) => LinearFile.parse(value),
    });
  }
  read(): Promise<LinearFile> { return this.file.read(); }
  update(op: (file: LinearFile) => LinearFile | Promise<LinearFile>): Promise<LinearFile> {
    return this.file.update(op);
  }
}
