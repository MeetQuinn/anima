import type { WebClient } from '@slack/web-api';

import { errorMessage } from '../ids.js';
import type { InboxItem } from '../inbox/wake-queue.service.js';
import type { FeishuMessageClient } from '../feishu/client.js';
import type { ProviderRetryClass } from '../providers/provider-retry.js';
import { providerFailureReasonFromError } from '../providers/provider-failure.js';
import { recordRuntimeEvent } from './activity.js';

/** Why the runtime gave up on an inbox item, as passed to the failure-notice hook. */
export interface RuntimeItemFailure {
  error: unknown;
  /** Retry attempts spent before giving up (0 when the error was terminal at once). */
  retryAttempts: number;
  retryClass: ProviderRetryClass | 'rate_limit_deferrals_exhausted' | 'unknown';
}

export interface SlackFailureNoticePost {
  channel: string;
  text: string;
  thread_ts?: string;
}

const MAX_REASON_CHARS = 160;

/**
 * Short, requester-facing explanation. Deliberately plain: the person who
 * asked needs to know their message was dropped and that re-sending works —
 * not the provider's full diagnostic.
 */
export function failureNoticeText(failure: RuntimeItemFailure): string {
  return `⚠️ I couldn't process this message (${failureReasonSummary(failure)}). Please send it again.`;
}

export function failureReasonSummary(failure: RuntimeItemFailure): string {
  const reason = providerFailureReasonFromError(failure.error);
  const attempts = failure.retryAttempts > 0 ? ` after ${failure.retryAttempts} ${failure.retryAttempts === 1 ? 'retry' : 'retries'}` : '';
  if (failure.retryClass === 'rate_limit_deferrals_exhausted' || reason === 'provider_rate_limited') {
    return 'the model provider stayed rate-limited';
  }
  if (reason === 'provider_quota_exhausted') return 'the model provider quota is exhausted';
  if (reason === 'provider_auth_failed') return 'model provider authentication failed';
  if (/safeguards flagged/i.test(errorMessage(failure.error))) {
    return `the model provider refused the request${attempts}`;
  }
  return `model provider error${attempts}: ${shortError(failure.error)}`;
}

/**
 * Only messages that explicitly addressed the agent get a notice. Channel and
 * thread follows are passive observation; posting failures there would be noise
 * in someone else's conversation.
 */
export function shouldNotifyRequester(item: InboxItem): boolean {
  if (item.kind !== 'slack' && item.kind !== 'feishu') return false;
  const wakeReason = item.wakeReason
    ?? (item.kind === 'slack' && item.channelId.startsWith('D') ? 'dm' : undefined)
    ?? (item.kind === 'feishu' && item.chatType === 'p2p' ? 'dm' : undefined);
  return wakeReason === 'dm' || wakeReason === 'mention';
}

export function slackFailureNoticePost(item: InboxItem, failure: RuntimeItemFailure): SlackFailureNoticePost | undefined {
  if (item.kind !== 'slack' || !shouldNotifyRequester(item)) return undefined;
  const isDm = item.channelId.startsWith('D');
  const threadTs = item.threadTs ?? (isDm ? undefined : item.messageTs);
  return {
    channel: item.channelId,
    text: failureNoticeText(failure),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  };
}

export async function postRuntimeFailureNotice(input: {
  agentId: string;
  failure: RuntimeItemFailure;
  feishuClient?: Pick<FeishuMessageClient, 'replyText'>;
  item: InboxItem;
  logger?: Pick<Console, 'error'>;
  runtimeKind: string;
  slackClient?: Pick<WebClient, 'chat'>;
}): Promise<boolean> {
  const { item } = input;
  if (!shouldNotifyRequester(item)) return false;
  try {
    if (item.kind === 'slack') {
      const post = slackFailureNoticePost(item, input.failure);
      if (!post || !input.slackClient) return false;
      await input.slackClient.chat.postMessage(post);
    } else if (item.kind === 'feishu') {
      if (!input.feishuClient) return false;
      await input.feishuClient.replyText({
        messageId: item.messageId,
        replyInThread: Boolean(item.threadId),
        text: failureNoticeText(input.failure),
      });
    } else {
      return false;
    }
  } catch (error) {
    input.logger?.error(`Runtime failure notice failed for item ${item.id}: ${errorMessage(error)}`);
    return false;
  }
  await recordRuntimeEvent(
    { agentId: input.agentId, itemId: item.id },
    input.runtimeKind,
    undefined,
    {
      eventType: 'runtime.failure_notice',
      reason: failureReasonSummary(input.failure),
      retryClass: input.failure.retryClass,
    },
  ).catch((error: unknown) => {
    input.logger?.error(`Runtime failure notice activity failed for item ${item.id}: ${errorMessage(error)}`);
  });
  return true;
}

function shortError(error: unknown): string {
  const firstLine = errorMessage(error).split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'unknown error';
  const stripped = firstLine.replace(/^API Error:\s*/i, '').replace(/\s*\(api status \d+\)\s*$/i, '');
  return stripped.length > MAX_REASON_CHARS ? `${stripped.slice(0, MAX_REASON_CHARS - 1)}…` : stripped;
}
