import { truncateForActivity } from '../activities/format.js';

export type ReasoningProvider = 'claude' | 'codex' | 'kimi';
export type ReasoningTextKind = 'raw' | 'summary' | 'think';

export function exposedReasoningEvent(input: {
  identity?: Record<string, unknown>;
  provider: ReasoningProvider;
  runtimeKind: string;
  sourceEventType: string;
  text: string | undefined;
  textKind: ReasoningTextKind;
}): Record<string, unknown> {
  const text = input.text?.trim() ?? '';
  const truncated = truncateForActivity(text);
  return {
    eventType: 'provider.reasoning',
    ...(input.identity ?? {}),
    provider: input.provider,
    runtimeKind: input.runtimeKind,
    sourceEventType: input.sourceEventType,
    status: 'exposed',
    ...(truncated ? { text: truncated } : {}),
    textKind: input.textKind,
    textTruncated: text.length > truncated.length,
  };
}

export function notExposedReasoningEvent(input: {
  provider: ReasoningProvider;
  runtimeKind: string;
}): Record<string, unknown> {
  return {
    eventType: 'provider.reasoning',
    provider: input.provider,
    reason: 'not_exposed_by_provider',
    runtimeKind: input.runtimeKind,
    status: 'not_exposed',
  };
}
