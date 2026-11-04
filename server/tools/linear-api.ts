import { randomUUID } from 'node:crypto';
import type { SelectionSetNode } from 'graphql';
import { z } from 'zod';
import { LINEAR_ISSUE_KEY } from '../../shared/linear-issue-key.js';
import { activityServiceForAgent, type ActivityService } from '../activities/activity.service.js';
import type { LinearIdentityService } from '../linear/identity.service.js';
import { assertLinearContactAllowed } from '../linear/contact-policy.js';
import { resolveToolItemId } from './tool-context.js';

type ApiInput = { query: string; variables: Record<string, unknown>; operationName?: string };
type ApiDescription = { operation: 'query' | 'mutation' | 'subscription' | 'unknown'; fields?: string[]; issueKey?: string };

const MAX_FIELDS = 5;
const FIELD_NAME = /^[_A-Za-z][_0-9A-Za-z]{0,63}$/;

/**
 * The selected operation's type and top-level schema field names (never aliases),
 * plus an issue key only when the top-level variables hold exactly one distinct whole-value key.
 */
async function describeOperation(input: ApiInput): Promise<ApiDescription> {
  try {
    const { getOperationAST, parse, Kind } = await import('graphql');
    const document = parse(input.query);
    const operation = getOperationAST(document, input.operationName);
    if (!operation) return { operation: 'unknown' };
    const fragments = new Map<string, SelectionSetNode>();
    for (const d of document.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d.selectionSet);
    const fields = new Set<string>();
    const expanded = new Set<string>();
    const visit = (set: SelectionSetNode): void => {
      for (const selection of set.selections) {
        if (fields.size >= MAX_FIELDS) return;
        if (selection.kind === Kind.FIELD) { if (FIELD_NAME.test(selection.name.value)) fields.add(selection.name.value); }
        else if (selection.kind === Kind.INLINE_FRAGMENT) visit(selection.selectionSet);
        else if (!expanded.has(selection.name.value)) {
          expanded.add(selection.name.value);
          const fragment = fragments.get(selection.name.value);
          if (fragment) visit(fragment);
        }
      }
    };
    visit(operation.selectionSet);
    const keys = new Set(Object.values(input.variables).filter((v): v is string => typeof v === 'string' && LINEAR_ISSUE_KEY.test(v)));
    return {
      operation: operation.operation,
      ...(fields.size ? { fields: [...fields] } : {}),
      ...(keys.size === 1 ? { issueKey: [...keys][0] } : {}),
    };
  }
  catch { return { operation: 'unknown' }; }
}

/** GraphQL text, aliases, variables, results and errors can all contain private data. */
export async function runLinearApi(identity: LinearIdentityService, input: ApiInput): Promise<unknown> {
  let itemId: string | undefined;
  try { itemId = await resolveToolItemId({ agent: identity.agentId }); }
  catch {
    itemId = process.env.ANIMA_INBOX_ITEM_ID?.trim() || undefined;
    console.error('Linear API runtime association lookup failed; using the inherited item ID when available.');
  }
  const payload: Record<string, unknown> = {
    tool: 'anima.linear.api', platform: 'linear', callId: randomUUID(),
    ...await describeOperation(input),
  };
  if (itemId) payload.itemId = itemId;
  // Reads cannot contact anyone. Anything else, including an unparseable document, is checked.
  if (payload.operation !== 'query') await assertLinearContactAllowed({ identity, tool: 'anima.linear.api', payload, document: input });
  const activity: ActivityService = activityServiceForAgent(identity.agentId);
  try { await activity.record({ type: 'tool.call.started', payload: { ...payload, status: 'started' } }); }
  catch { throw new Error('Linear API audit could not be started; no request was sent.'); }

  let result: unknown;
  try { result = await identity.request(input.query, input.variables, z.unknown(), input.operationName); }
  catch (error) {
    try { await activity.record({ type: 'tool.call.failed', payload: { ...payload, status: 'failed', outcome: 'unknown' } }); }
    catch { console.error('Linear API failed and its audit is incomplete. Inspect the remote result before repeating a write.'); }
    throw error;
  }
  try { await activity.record({ type: 'tool.call.completed', payload: { ...payload, status: 'completed', outcome: 'request_completed' } }); }
  catch { console.error('Linear API returned a result but its audit is incomplete. Do not repeat a write to repair the audit.'); }
  return result;
}
