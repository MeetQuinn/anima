import type { PublicUrlCheck, PublicUrlSettings } from '@shared/public-url';
import { apiRequest, jsonInit } from './client';

export const publicUrlKey = ['server', 'public-url'] as const;
export const publicUrlCheckKey = ['server', 'public-url-check'] as const;
export const fetchPublicUrl = (): Promise<PublicUrlSettings> =>
  apiRequest('/api/settings/public-url');
export const savePublicUrl = (publicUrl: string): Promise<PublicUrlSettings> =>
  apiRequest('/api/settings/public-url', jsonInit('PUT', { publicUrl }));
/** Anima fetches a one-time probe through the public address, as Linear would. */
export const checkPublicUrl = (): Promise<PublicUrlCheck> =>
  apiRequest('/api/settings/public-url/check', { method: 'POST' });
