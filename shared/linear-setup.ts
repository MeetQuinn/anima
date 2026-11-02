import { z } from 'zod';
import { PublicHttpsUrl } from './public-url.js';
import { LinearCallbackUrl, LinearListenerConfig } from './linear.js';

export const LinearWebhookUrl = PublicHttpsUrl.pipe(z.string().refine((value) => {
  const host = new URL(value).hostname;
  return host !== 'linear.app' && !host.endsWith('.linear.app');
}, 'Use your Anima address, not linear.app.'));

export const LinearSetupRequest = z
  .object({
    listener: LinearListenerConfig,
  })
  .strict();
export type LinearSetupRequest = z.infer<typeof LinearSetupRequest>;
export interface LinearSetup {
  publicUrl?: string;
  webhookUrl?: string;
  callbackUrl?: string;
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
