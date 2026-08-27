import { z } from 'zod';

import type { ProviderKind } from './provider-catalog.js';
import { ProviderUsageKind } from './provider-usage.js';

// Provider sign-in run from the dashboard. Anima never handles the credential:
// it runs the provider's own login subcommand with the runtime command the
// operator configured, relays the URL (and device code) the CLI prints, and
// reports how the child exited. The provider CLI writes its own credential
// store, so a wrapper such as a multi-account router receives the login too.

export const ProviderLoginMode = z.enum(['browser', 'device']);
export type ProviderLoginMode = z.infer<typeof ProviderLoginMode>;

export interface ProviderLoginSpec {
  browserArgs: string[];
  deviceArgs: string[];
  /** Minutes until the printed code or link stops working; the run is cut off then. */
  expiresAfterMinutes: number;
  statusArgs: string[];
}

export const PROVIDER_LOGIN_SPECS: Partial<Record<ProviderKind, ProviderLoginSpec>> = {
  'codex-cli': {
    browserArgs: ['login'],
    deviceArgs: ['login', '--device-auth'],
    expiresAfterMinutes: 15,
    statusArgs: ['login', 'status'],
  },
};

export function providerLoginSpec(provider: ProviderKind): ProviderLoginSpec | undefined {
  return PROVIDER_LOGIN_SPECS[provider];
}

export const ProviderLoginOperation = z.object({
  code: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  expiresAt: z.string().optional(),
  mode: ProviderLoginMode.optional(),
  startedAt: z.string().optional(),
  status: z.enum(['idle', 'running', 'succeeded', 'failed', 'cancelled']),
  url: z.string().optional(),
});
export type ProviderLoginOperation = z.infer<typeof ProviderLoginOperation>;

export const ProviderLoginRow = z.object({
  checkedAt: z.string().optional(),
  /** The runtime command the login runs through, as configured (name or absolute path). */
  command: z.string(),
  /** One line from `login status`, redacted; present when the CLI printed one. */
  detail: z.string().optional(),
  operation: ProviderLoginOperation,
  provider: ProviderUsageKind,
  state: z.enum(['signed_in', 'signed_out', 'unknown', 'unsupported']),
});
export type ProviderLoginRow = z.infer<typeof ProviderLoginRow>;

export const ProviderLoginStatusResponse = z.object({
  providers: z.array(ProviderLoginRow),
});
export type ProviderLoginStatusResponse = z.infer<typeof ProviderLoginStatusResponse>;

export const ProviderLoginStartRequest = z.object({ mode: ProviderLoginMode }).strict();
export type ProviderLoginStartRequest = z.infer<typeof ProviderLoginStartRequest>;
