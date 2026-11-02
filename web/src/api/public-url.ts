import type { PublicUrlSettings } from '@shared/public-url';
import { apiRequest, jsonInit } from './client';

export const publicUrlKey = ['server', 'public-url'] as const;
export const fetchPublicUrl = (): Promise<PublicUrlSettings> =>
  apiRequest('/api/settings/public-url');
export const savePublicUrl = (publicUrl: string): Promise<PublicUrlSettings> =>
  apiRequest('/api/settings/public-url', jsonInit('PUT', { publicUrl }));
