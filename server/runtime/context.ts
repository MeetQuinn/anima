import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { defaultAgentHomePath as defaultAgentHomeDisplayPath } from '../../shared/agent-home.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { runtimeSessionServiceForAgent } from './runtime-session.service.js';
import type { RuntimeWorkerConfig, RuntimeItemContext } from './types.js';
import type { InboxItem } from '../../shared/inbox.js';

export interface RuntimeContextQueue {
  find(itemId: string): Promise<InboxItem | undefined>;
}

export async function runtimeContextForItemId(
  itemId: string,
  config: RuntimeWorkerConfig,
  queue: RuntimeContextQueue = new WakeQueueService(config.agentId),
): Promise<RuntimeItemContext> {
  const item = await queue.find(itemId);
  if (!item) throw new Error(`Wake queue item ${itemId} was not found.`);
  return {
    agentId: config.agentId,
    item,
    session: await runtimeSessionServiceForAgent(config.agentId).upsertPrimarySession(),
    stateDir: config.stateDir,
    homePath: config.homePath ?? defaultAgentHomePath(config.agentId),
  };
}

function defaultAgentHomePath(agentId: string): string {
  return expandHome(defaultAgentHomeDisplayPath(agentId));
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}
