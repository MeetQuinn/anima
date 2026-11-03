import { z } from 'zod';

export const LinearConfig = z.object({
  connected: z.boolean(),
  clientId: z.string(),
  organizationId: z.string(),
  appUserId: z.string(),
}).strict();
export type LinearConfig = z.infer<typeof LinearConfig>;

export const LinearListenerConfig = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1024).max(65535),
}).strict();
export type LinearListenerConfig = z.infer<typeof LinearListenerConfig>;
/** The app's webhook path on the public address, which points at the dashboard. */
export const LINEAR_WEBHOOK_PATH = '/webhooks/linear';
/** Where the runtime receives Linear events; the dashboard forwards them here. */
export const DEFAULT_LINEAR_LISTENER: LinearListenerConfig = { host: '127.0.0.1', port: 14185 };

export const LinearCallbackUrl = z.string().url().max(2048).refine((value) => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return !url.username && !url.password && !url.search && !url.hash
      && url.pathname === '/api/linear/oauth/callback'
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
}, 'Use an HTTPS or loopback callback ending in /api/linear/oauth/callback');

const LinearClientSecret = z.string().min(8).max(1024).regex(/^\S+$/);

export const LinearInstallRequest = z.object({
  clientId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  // Linear's token endpoint requires it even with PKCE (Nov 2026, invalid_client without it).
  clientSecret: LinearClientSecret,
  signingSecret: z.string().min(16).max(1024),
  callbackUrl: LinearCallbackUrl,
}).strict();
export type LinearInstallRequest = z.infer<typeof LinearInstallRequest>;

/** Adds the client secret to an installation made before Anima stored it. */
export const LinearClientSecretRequest = z.object({
  installationId: z.string().min(1).max(256),
  clientSecret: LinearClientSecret,
}).strict();
export type LinearClientSecretRequest = z.infer<typeof LinearClientSecretRequest>;

/**
 * saved: the secret and Linear's refreshed tokens were stored together.
 * rejected: Linear answered invalid_client. expired: invalid_grant, the
 * authorization is gone. unavailable: no usable answer from Linear (network,
 * 5xx, other errors); nothing changed. unsaved: Linear may have issued new
 * tokens but Anima could not store them. changed: the installation was
 * removed, revoked or replaced meanwhile.
 */
export type LinearClientSecretResult = 'saved' | 'rejected' | 'expired' | 'unavailable' | 'unsaved' | 'changed';

export const LinearListenerFailure = z.enum(['address_in_use', 'permission_denied', 'address_unavailable', 'other']);
export type LinearListenerFailure = z.infer<typeof LinearListenerFailure>;

export interface LinearListenerStatus {
  state: 'listening' | 'failed' | 'stopped' | 'unknown';
  observedAt?: string;
  reason?: LinearListenerFailure;
}

export interface LinearStatus {
  state: 'not_configured' | 'installing' | 'connected' | 'revoked';
  clientId?: string;
  /** Present with an installation; binds a client secret save to it. */
  installationId?: string;
  /** False for installations made before Anima stored the client secret. */
  clientSecretSaved?: boolean;
  /** Linear answered invalid_client when refreshing this installation's token. */
  clientRejected?: boolean;
  organizationId?: string;
  appUserId?: string;
  workspaceName?: string;
  lastSignedWebhookAt?: string;
  signatureFailures: number;
  /** Sessions with a finished request Anima has no recorded reply for, and no recorded activity for 30 minutes. Local records only; Linear's own session state may differ. */
  unansweredSessions?: number;
  lastError?: string;
  listener?: LinearListenerConfig;
  listenerStatus?: LinearListenerStatus;
}

export const LinearActivityKind = z.enum(['thought', 'response', 'elicitation', 'error']);
export type LinearActivityKind = z.infer<typeof LinearActivityKind>;
