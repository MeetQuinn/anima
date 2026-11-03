import { LINEAR_ISSUE_KEY } from '../../shared/linear-issue-key.js';

/** The issue key, such as `ANI-12`, from the payload's identifier or else the issue URL. */
export function linearIssueKey(identifier: string | null | undefined, url?: string | null): string | undefined {
  if (identifier && LINEAR_ISSUE_KEY.test(identifier)) return identifier;
  if (!url) return undefined;
  let segment: string | undefined;
  try {
    segment = /^\/[^/]+\/issue\/([^/]+)/.exec(new URL(url).pathname)?.[1];
  } catch {
    return undefined;
  }
  return segment && LINEAR_ISSUE_KEY.test(segment) ? segment : undefined;
}

/**
 * What a status or unassign notification reports, without its actor. Linear's
 * payload names neither the old nor the new status.
 */
export function linearNotificationEvent(type: string, key: string | undefined): string | undefined {
  const issue = key ?? 'the issue';
  if (type === 'issueStatusChanged') return `changed the status of ${issue}`;
  if (type === 'issueUnassignedFromYou') return `unassigned you from ${issue}`;
  return undefined;
}
