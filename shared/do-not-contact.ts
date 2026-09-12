import { z } from 'zod';
import type { SlackUserCandidate } from './agent-config.js';

export const ContactWorkspaceId = z.string().regex(/^T[A-Z0-9]+$/);
export const ContactMemberRequest = z.object({
  userId: z.string().regex(/^U[A-Z0-9]+$/),
}).strict();

export interface ContactWorkspace {
  id: string;
  name: string;
  memberIds: string[];
  canLookup: boolean;
}

export interface ContactDirectory {
  users: SlackUserCandidate[];
}
