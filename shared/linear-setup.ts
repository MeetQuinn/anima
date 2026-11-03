import { z } from 'zod';
import { PublicHttpsUrl } from './public-url.js';
import { LinearCallbackUrl } from './linear.js';

export const LinearWebhookUrl = PublicHttpsUrl.pipe(z.string().refine((value) => {
  const host = new URL(value).hostname;
  return host !== 'linear.app' && !host.endsWith('.linear.app');
}, 'Use your Anima address, not linear.app.'));

export interface LinearSetup {
  publicUrl?: string;
  webhookUrl?: string;
  callbackUrl?: string;
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

/**
 * Linear fetches the app icon itself, so only a public HTTPS image qualifies
 * (no private hosts, credentials or signed query strings). Anything else is
 * left out and the app is created without an icon.
 */
export function linearAppIconUrl(value: string | undefined): string | undefined {
  const parsed = value ? PublicHttpsUrl.safeParse(value) : undefined;
  return parsed?.success ? parsed.data : undefined;
}

export function linearAppCreationUrl(input: {
  name: string;
  callbackUrl: string;
  webhookUrl: string;
  iconUrl?: string;
}): string {
  const iconUrl = linearAppIconUrl(input.iconUrl);
  const url = new URL('https://linear.app/settings/api/applications/new');
  url.searchParams.set(
    'manifest',
    JSON.stringify({
      schemaVersion: '1.0.0',
      distribution: 'private',
      developer: { name: 'Anima' },
      ...(iconUrl ? { display: { iconUrl } } : {}),
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
