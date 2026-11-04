import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { activityServiceForAgent, type ActivityService } from '../activities/activity.service.js';
import type { LinearIdentityService } from '../linear/identity.service.js';
import { assertLinearContactAllowed } from '../linear/contact-policy.js';
import { resolveToolItemId } from './tool-context.js';
import { describeLinearApi, summarizeLinearApi } from '../linear/api-summary.js';
import { LinearApiError } from '../linear/client.js';

type ApiInput = { query: string; variables: Record<string, unknown>; operationName?: string };
/** GraphQL text, aliases, variables, results and errors can all contain private data. */
export async function runLinearApi(identity: LinearIdentityService, input: ApiInput): Promise<unknown> {
  let itemId: string | undefined;
  try { itemId = await resolveToolItemId({ agent: identity.agentId }); }
  catch {
    itemId = process.env.ANIMA_INBOX_ITEM_ID?.trim() || undefined;
    console.error('Linear API runtime association lookup failed; using the inherited item ID when available.');
  }
  const operation = describeLinearApi(input);
  const payload: Record<string, unknown> = {
    tool: 'anima.linear.api', platform: 'linear', callId: randomUUID(),
    ...operation.audit,
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
    const failed = { ...payload, status: 'failed', outcome: 'unknown' } as Record<string, unknown>;
    if (error instanceof LinearApiError) {
      if (error.failure) failed.failure = error.failure;
      if (error.status) failed.httpStatus = error.status;
    }
    try { await activity.record({ type: 'tool.call.failed', payload: failed }); }
    catch { console.error('Linear API failed and its audit is incomplete. Inspect the remote result before repeating a write.'); }
    throw error;
  }
  const completed = { ...payload, status: 'completed', outcome: 'request_completed' } as Record<string, unknown>;
  const summary = summarizeLinearApi(operation, result);
  if (summary) completed.summary = summary;
  try { await activity.record({ type: 'tool.call.completed', payload: completed }); }
  catch { console.error('Linear API returned a result but its audit is incomplete. Do not repeat a write to repair the audit.'); }
  return result;
}
