// API contract types for agent activity records. Consumed by server and web.

export type ActivityStatus = 'started' | 'completed' | 'failed';

export type ActivityPayload = Record<string, unknown>;

export interface ActivityBase<TType extends string, TPayload = ActivityPayload> {
  activityId: string;
  createdAt: string;
  payload?: TPayload & ActivityPayload;
  type: TType;
}

export interface RuntimePayload {
  runtimeKind?: string;
}

export interface AgentTextPayload extends RuntimePayload {
  eventType?: string;
  text: string;
}

export interface RuntimeOutputPayload extends RuntimePayload {
  stream: 'stderr' | 'stdout';
  text: string;
}

export interface RuntimeStartedPayload extends RuntimePayload {
  command?: string;
  providerSession?: {
    id: string;
    kind: string;
    resumed?: boolean;
  };
  transport?: string;
}

export interface RuntimeFailedPayload extends RuntimePayload {
  error?: string;
  failureSource?: 'provider' | (string & {});
  maxRetries?: number;
  providerReason?: string;
  retryAttempts?: number;
  retryable?: boolean;
}

export interface RuntimeAbortedPayload {
  reason: 'idle_timeout' | 'operator_restart' | 'shutdown' | 'user_stop' | (string & {});
  timeoutMs?: number;
}

export interface RuntimePendingPayload extends RuntimePayload {
  activeItemId?: string;
  reason: 'followup_rejected' | 'steer_rejected' | (string & {});
}

export interface RuntimeFollowupPayload {
  activeItemId: string;
  agentRuntime?: string;
  text?: string;
}

export interface RuntimeFollowupFailedPayload {
  activeItemId: string;
  agentRuntime?: string;
  error: string;
  reason: 'followup_failed' | 'steer_failed' | (string & {});
}

export type MemoryCoherenceOutcome = 'completed' | 'quiet_skipped' | 'failed';

export interface MemoryCoherenceOutcomePayload {
  completedAt: string;
  delayMs?: number;
  failureReason?: string;
  outcome: MemoryCoherenceOutcome;
  scheduledSlotAt: string;
  scheduledSlotLabel: string;
  startedAt: string;
  summary?: string;
}

export interface RuntimeEventPayload extends RuntimePayload {
  eventType: string;
  [key: string]: unknown;
}

export interface ToolCallPayload {
  command?: string;
  error?: string;
  provider?: string;
  providerToolId?: string;
  providerToolName?: string;
  target?: string;
  tool?: string;
  [key: string]: unknown;
}

export interface ExternalEffectPayload {
  effect: string;
  status?: ActivityStatus;
  tool?: string;
  [key: string]: unknown;
}

export interface SessionRotatePayload {
  archivedCount?: number;
}

export interface SubscriptionEffectPayload {
  channelId: string;
  channelName?: string;
  kind?: 'channel' | 'thread';
  threadTs?: string;
}

export interface AttentionSuggestionPayload {
  channelId: string;
  channelName?: string;
  channelKind?: string;
  platform: 'slack' | 'feishu' | (string & {});
  suggestion: string;
  threadTs?: string;
}

export type AgentMessageActivity = ActivityBase<'agent.text', AgentTextPayload>;

export type RuntimeLifecycleActivity =
  | ActivityBase<'runtime.started', RuntimeStartedPayload>
  | ActivityBase<'runtime.completed', RuntimePayload>
  | ActivityBase<'runtime.failed', RuntimeFailedPayload>
  | ActivityBase<'runtime.aborted', RuntimeAbortedPayload>
  | ActivityBase<'runtime.pending', RuntimePendingPayload>
  | ActivityBase<'runtime.followup_appended', RuntimeFollowupPayload>
  | ActivityBase<'runtime.followup_failed', RuntimeFollowupFailedPayload>
  | ActivityBase<'runtime.steered', RuntimeFollowupPayload>
  | ActivityBase<'runtime.steer_failed', RuntimeFollowupFailedPayload>;

export type RuntimeOutputActivity = ActivityBase<'runtime.output', RuntimeOutputPayload>;
export type ProviderEventActivity = ActivityBase<'runtime.event', RuntimeEventPayload>;
export type MemoryCoherenceActivity = ActivityBase<'memory_coherence.outcome', MemoryCoherenceOutcomePayload>;

export type ToolCallActivity =
  | ActivityBase<'tool.call.started', ToolCallPayload>
  | ActivityBase<'tool.call.completed', ToolCallPayload>
  | ActivityBase<'tool.call.failed', ToolCallPayload>;

export type ExternalEffectActivity =
  | ActivityBase<'external.effect.started', ExternalEffectPayload>
  | ActivityBase<'external.effect.completed', ExternalEffectPayload>
  | ActivityBase<'external.effect.failed', ExternalEffectPayload>
  | ActivityBase<'anima.session.rotate', SessionRotatePayload>
  | ActivityBase<'anima.subscription.add', SubscriptionEffectPayload>
  | ActivityBase<'anima.subscription.mute', SubscriptionEffectPayload>
  | ActivityBase<'anima.subscription.remove', SubscriptionEffectPayload>
  | ActivityBase<'anima.attention.suggestion', AttentionSuggestionPayload>;

export type Activity =
  | AgentMessageActivity
  | RuntimeLifecycleActivity
  | RuntimeOutputActivity
  | ProviderEventActivity
  | MemoryCoherenceActivity
  | ToolCallActivity
  | ExternalEffectActivity
  | ActivityBase<string, Record<string, unknown>>;

export type ActivityType = Activity['type'];

export interface AgentActivityFeedEvent {
  activity: Activity;
  kind: 'activity';
  timestamp: string;
}

export interface AgentActivityFeedPage {
  events: AgentActivityFeedEvent[];
  // Cursor for the previous (older) page. ISO timestamp of the oldest feed
  // event in this response. Null means there are no older events to load.
  nextCursor?: string | null;
}
