import { LinearInboxItem } from '../../../shared/inbox.js';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveAnimaHome } from '../../anima-home.js';
import { JsonStore } from '../json-store.js';
import { AGENT_ID } from './agent.store.js';

const Installation = z.object({
  id: z.string(), clientId: z.string(), signingSecret: z.string(),
  organizationId: z.string(), appUserId: z.string(), accessToken: z.string(),
  refreshToken: z.string(), expiresAt: z.number(), revoked: z.boolean(),
});
export type LinearInstallation = z.infer<typeof Installation>;
const PendingOAuth = z.object({
  id: z.string(), clientId: z.string(), signingSecret: z.string(),
  callbackUrl: z.string(), verifier: z.string(), binding: z.string(), expiresAt: z.number(),
});
const Receipt = z.object({
  item: LinearInboxItem.optional(),
  sessionId: z.string(), issueId: z.string().optional(), receivedAt: z.string(),
  itemId: z.string().optional(), stopped: z.boolean().optional(), stopSignal: z.boolean().optional(),
  runItemId: z.string().optional(), settled: z.boolean().optional(),
  answered: z.boolean().optional(),
  acknowledgement: z.enum(['pending', 'sending', 'accepted', 'unknown']),
  acknowledgementId: z.string(),
  lastActivityAt: z.string().optional(),
  lastStatusAttemptAt: z.string().optional(),
});
export type LinearReceipt = z.infer<typeof Receipt>;
const Operation = z.object({
  id: z.string(), sessionId: z.string(), kind: z.enum(['activity', 'link']),
  state: z.enum(['sending', 'accepted', 'unknown']), itemIds: z.array(z.string()),
  contentHash: z.string(), ownerRunId: z.string().optional(), url: z.string().optional(),
});
export type LinearOperation = z.infer<typeof Operation>;
const LinearFile = z.object({
  installation: Installation.optional(),
  pending: PendingOAuth.optional(),
  receipts: z.record(z.string(), Receipt).default({}),
  operations: z.record(z.string(), Operation).default({}),
  lastSignedWebhookAt: z.string().optional(),
  signatureFailures: z.number().int().nonnegative().default(0),
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
      empty: () => ({ receipts: {}, operations: {}, signatureFailures: 0 }),
      parse: (value) => LinearFile.parse(value),
    });
  }
  read(): Promise<LinearFile> { return this.file.read(); }
  update(op: (file: LinearFile) => LinearFile | Promise<LinearFile>): Promise<LinearFile> {
    return this.file.update(op);
  }
}
