import { randomUUID } from 'node:crypto';
import { getOperationAST, parse } from 'graphql';
import { z } from 'zod';
import { activityServiceForAgent, type ActivityService } from '../activities/activity.service.js';
import type { LinearIdentityService } from '../linear/identity.service.js';
import { resolveToolItemId } from './tool-context.js';

type ApiInput = { query: string; variables: Record<string, unknown>; operationName?: string };

function operationKind(input: ApiInput): 'query' | 'mutation' | 'subscription' | 'unknown' {
  try { return getOperationAST(parse(input.query), input.operationName)?.operation ?? 'unknown'; }
  catch { return 'unknown'; }
}

/** GraphQL text, names, variables, results and errors can all contain private data. */
export async function runLinearApi(identity: LinearIdentityService, input: ApiInput): Promise<unknown> {
  let itemId: string | undefined;
  try { itemId = await resolveToolItemId({ agent: identity.agentId }); }
  catch { console.error('Linear API runtime association is unavailable.'); }
  const payload: Record<string, unknown> = {
    tool: 'anima.linear.api', platform: 'linear', callId: randomUUID(),
    operation: operationKind(input),
  };
  if (itemId) payload.itemId = itemId;
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
