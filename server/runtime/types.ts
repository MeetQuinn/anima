import type { InboxItem } from '../inbox/wake-queue.service.js';
import type { Session } from './runtime-session.service.js';

export interface RuntimeWorkerConfig {
  agentId: string;
  stateDir: string;
  homePath?: string;
}

export interface RuntimeItemContext {
  agentId: string;
  item: InboxItem;
  session: Session;
  stateDir: string;
  homePath: string;
}

export type ItemStopReason =
  | 'idle_timeout'
  | 'operator_restart'
  | 'restart_drain'
  | 'shutdown'
  | 'user_stop';
