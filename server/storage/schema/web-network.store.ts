import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';

import { resolveAnimaHome } from '../../anima-home.js';
import { JsonStore } from '../json-store.js';

const Address = z.string().refine(isIPv4, 'Expected a literal IPv4 address');
const HostName = z.string().max(253).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
const WebListener = z.object({
  host: Address.refine((host) => host !== '0.0.0.0', 'Wildcard listeners are not allowed here'),
  allowedPeers: z.array(Address).min(1).max(32).optional(),
  allowedHosts: z.array(HostName).min(1).max(32).optional(),
}).strict().superRefine((listener, ctx) => {
  if (!listener.host.startsWith('127.') && (!listener.allowedPeers || !listener.allowedHosts)) {
    ctx.addIssue({ code: 'custom', message: 'Non-loopback listeners require allowedPeers and allowedHosts' });
  }
  if (Boolean(listener.allowedPeers) !== Boolean(listener.allowedHosts)) {
    ctx.addIssue({ code: 'custom', message: 'allowedPeers and allowedHosts must be supplied together' });
  }
});
export type WebListener = z.infer<typeof WebListener>;

export const WebNetworkConfig = z.object({
  listeners: z.array(WebListener).min(1).max(8).refine(
    (listeners) => new Set(listeners.map((listener) => listener.host)).size === listeners.length,
    'Duplicate listener addresses',
  ).optional(),
}).strict();
export type WebNetworkConfig = z.infer<typeof WebNetworkConfig>;

// A separate file lets the web process upgrade without putting unknown fields
// into an old, still-running agent's strict config.json schema.
export class WebNetworkStore {
  constructor(private readonly animaHome?: string) {}

  private readonly file = new JsonStore<WebNetworkConfig>({
    empty: () => ({}),
    parse: WebNetworkConfig.parse,
    path: () => join(this.animaHome ?? resolveAnimaHome(), 'web-network.json'),
    writeRoot: () => this.animaHome ?? resolveAnimaHome(),
  });

  read(): Promise<WebNetworkConfig> {
    return this.file.read();
  }
}
