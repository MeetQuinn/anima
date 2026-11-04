import { z } from 'zod';
import type { SlackUserCandidate } from './agent-config.js';

export const ContactWorkspaceId = z.string().regex(/^T[A-Z0-9]+$/);
export const ContactMemberRequest = z.object({
  userId: z.string().regex(/^U[A-Z0-9]+$/),
}).strict();

/** Linear IDs are UUIDs; stored and compared in lower case. */
const LinearId = z.string().uuid().transform((id) => id.toLowerCase());
export const LinearContactOrganizationId = LinearId;
export const LinearContactMemberRequest = z.object({ userId: LinearId }).strict();

export type ContactPlatform = 'slack' | 'linear';

/** One workspace's list: a Slack workspace (`T…`) or a Linear organization (UUID). */
export interface ContactWorkspace {
  platform: ContactPlatform;
  id: string;
  name: string;
  memberIds: string[];
  canLookup: boolean;
}

export interface ContactDirectory {
  users: SlackUserCandidate[];
}

/** A person (never an app user or agent) in a Linear organization. No email. */
export interface LinearContactCandidate {
  linearUserId: string;
  name: string;
  displayName: string;
  avatarUrl?: string;
}

export interface LinearContactDirectory {
  users: LinearContactCandidate[];
}
