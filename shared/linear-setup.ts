import { z } from 'zod';
import { LinearCallbackUrl, LinearListenerConfig } from './linear.js';

// This validates the URL's syntax, not DNS or whether a tunnel is reachable.
export const LinearWebhookUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const octets = host.split('.').map(Number);
    const privateV4 =
      octets.length === 4 &&
      octets.every(Number.isInteger) &&
      (octets[0] === 0 ||
        octets[0] === 10 ||
        octets[0] === 127 ||
        octets[0]! >= 224 ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127));
    // Public DNS names are supported; literal IPv6 addresses need a public hostname.
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      host.includes('.') &&
      !host.includes(':') &&
      !privateV4 &&
      !['localhost', 'local', 'internal', 'test', 'invalid'].some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      ) &&
      host !== 'linear.app' &&
      !host.endsWith('.linear.app')
    );
  }, 'Use a public HTTPS webhook URL without credentials, query parameters or a fragment.');

export const LinearSetupRequest = z
  .object({
    webhookUrl: LinearWebhookUrl,
    listener: LinearListenerConfig,
  })
  .strict();
export type LinearSetupRequest = z.infer<typeof LinearSetupRequest>;
export interface LinearSetup {
  webhookUrl?: string;
  listener: z.infer<typeof LinearListenerConfig>;
  listenerLocked: boolean;
}

export const LinearAppName = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .refine(
    (value) => !/linear|https?:\/\//i.test(value),
    'Use 2–80 characters without Linear or a URL.',
  );

export function defaultLinearAppName(agentName: string): string {
  const name = agentName
    .replace(/linear|https?:\/\//gi, '')
    .trim()
    .slice(0, 80);
  return name.length >= 2 ? name : `Anima ${name || 'agent'}`;
}

export function linearAppCreationUrl(input: {
  name: string;
  callbackUrl: string;
  webhookUrl: string;
}): string {
  const url = new URL('https://linear.app/settings/api/applications/new');
  url.searchParams.set(
    'manifest',
    JSON.stringify({
      schemaVersion: '1.0.0',
      distribution: 'private',
      developer: { name: 'Anima' },
      oauth: {
        client_name: LinearAppName.parse(input.name),
        client_uri: 'https://github.com/MeetQuinn/anima',
        redirect_uris: [LinearCallbackUrl.parse(input.callbackUrl)],
        grant_types: ['authorization_code'],
      },
      webhook: {
        enabled: true,
        url: LinearWebhookUrl.parse(input.webhookUrl),
        resourceTypes: [
          'AgentSessionEvent',
          'AppUserNotification',
          'PermissionChange',
        ],
      },
    }),
  );
  return url.toString();
}
