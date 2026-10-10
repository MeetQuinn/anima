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

export const LinearInstallRequest = z.object({
  clientId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  signingSecret: z.string().min(16).max(1024),
  callbackUrl: z.string().url().max(2048).refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash
      && url.pathname === '/api/linear/oauth/callback'
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }, 'Use an HTTPS or loopback callback ending in /api/linear/oauth/callback'),
  listener: LinearListenerConfig,
}).strict();
export type LinearInstallRequest = z.infer<typeof LinearInstallRequest>;

export interface LinearStatus {
  state: 'not_configured' | 'installing' | 'connected' | 'revoked';
  clientId?: string;
  organizationId?: string;
  appUserId?: string;
  lastSignedWebhookAt?: string;
  signatureFailures: number;
  lastError?: string;
  listener?: LinearListenerConfig;
}

export const LinearActivityKind = z.enum(['response', 'elicitation', 'error']);
export type LinearActivityKind = z.infer<typeof LinearActivityKind>;
