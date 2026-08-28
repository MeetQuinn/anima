import { runtimeSessionServiceForAgent, tokenDeltaForActivities } from './runtime-session.service.js';

export { tokenDeltaForActivities };

export function recordLifetimeTokenUsageForItem(agentId: string, itemId: string): Promise<number | undefined> {
  return runtimeSessionServiceForAgent(agentId).recordLifetimeTokenUsageForItem(itemId);
}
