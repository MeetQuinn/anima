import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { LinearInstallation } from '../storage/schema/linear.store.js';

const Id = z.string().uuid();
const Common = z.object({ organizationId: Id, oauthClientId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/), webhookTimestamp: z.number().finite() });
const Session = z.object({
  id: Id, appUserId: Id, organizationId: Id, issueId: Id.nullish(), url: z.string().url().nullish(),
  issue: z.object({ id: Id, title: z.string(), description: z.string().nullish(), url: z.string().url().nullish() }).nullish(),
  comment: z.object({ body: z.string().max(100_000) }).nullish(),
  creatorId: Id.nullish(), creator: z.object({ name: z.string() }).nullish(),
});
const Prompt = z.object({
  id: Id, agentSessionId: Id, signal: z.string().nullish(), body: z.string().max(100_000).optional(),
  content: z.object({ type: z.literal('prompt'), body: z.string().max(100_000) }).optional(),
});
export const LinearWebhook = z.discriminatedUnion('type', [
  Common.extend({ type: z.literal('AgentSessionEvent'), action: z.enum(['created', 'prompted']),
    appUserId: Id, agentSession: Session, promptContext: z.string().max(200_000).nullish(), agentActivity: Prompt.optional(), guidance: z.array(z.object({ body: z.string().max(50_000) })).max(100).nullish(),
  }),
  Common.extend({ type: z.literal('OAuthApp'), action: z.literal('revoked') }),
]);
export type LinearWebhook = z.infer<typeof LinearWebhook>;

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
      if (event.agentActivity.signal !== 'stop' && !(event.agentActivity.body ?? event.agentActivity.content?.body)?.trim()) throw new Error('Empty Linear prompt');
    }
  }
  return event;
}
