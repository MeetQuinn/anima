import { z } from 'zod';
import { LINEAR_ISSUE_KEY } from './linear-issue-key.js';

export const LinearApiChange = z.enum(['status', 'assignee', 'delegate', 'title', 'description', 'priority', 'labels', 'project', 'team', 'cycle', 'due date']);
export type LinearApiChange = z.infer<typeof LinearApiChange>;

// A bounded display projection, never the request or response document.
export const LinearApiSummary = z.object({
  issueKey: z.string().regex(LINEAR_ISSUE_KEY).optional(),
  issueTitle: z.string().min(1).max(240).optional(),
  issueUrl: z.string().max(2000).url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'linear.app' && !url.username && !url.password
      && !url.search && !url.hash && /\/issue\/[^/]+/.test(url.pathname);
  }).optional(),
  success: z.boolean().optional(),
  changes: z.array(LinearApiChange).max(11).optional(),
  stateName: z.string().min(1).max(80).optional(),
  assigneeName: z.string().min(1).max(120).nullable().optional(),
  delegateName: z.string().min(1).max(120).nullable().optional(),
  resultCount: z.number().int().nonnegative().optional(),
  hasNextPage: z.boolean().optional(),
  found: z.boolean().optional(),
});
export type LinearApiSummary = z.infer<typeof LinearApiSummary>;
