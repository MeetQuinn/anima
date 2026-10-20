import type { InboxItem } from '../../shared/inbox.js';
import { runtimeSessionServiceForAgent, tokenDeltaForActivities } from './runtime-session.service.js';

export { tokenDeltaForActivities };

export function recordLifetimeTokenUsageForItem(agentId: string, item: InboxItem): Promise<number | undefined> {
  return runtimeSessionServiceForAgent(agentId).recordLifetimeTokenUsageForItem(item);
}
