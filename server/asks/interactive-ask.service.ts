import type { WebClient } from '@slack/web-api';

import type { ChoiceResponseInboxItem } from '../../shared/inbox.js';
import { activityServiceForAgent, type ActivityService } from '../activities/activity.service.js';
import { errorMessage, nowIso } from '../ids.js';
import { WakeQueueService, wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import { SlackWorkspaceDirectoryService, type SlackUserInfo } from '../slack/workspace-directory.service.js';
import { SLACK_NO_UNFURL, slackMarkdownBlockText } from '../tools/slack-message-format.js';
import {
  InteractiveAskStore,
  type InteractiveAskOption,
  type InteractiveAskRecord,
} from '../storage/schema/interactive-ask.store.js';

export const INTERACTIVE_ASK_ACTION_ID = 'anima.ask.answer';
const INTERACTIVE_ASK_ANSWERED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface InteractiveAskAnswerInput {
  askId: string;
  client: WebClient;
  optionId: string;
  userId: string;
}

export interface InteractiveAskAnswerResult {
  ask?: InteractiveAskRecord;
  outcome: 'answered' | 'already_answered' | 'forbidden' | 'not_found' | 'invalid_option';
  queued?: boolean;
}

export class InteractiveAskService {
  constructor(
    agentId: string,
    private readonly store: InteractiveAskStore = new InteractiveAskStore(agentId),
    private readonly queue: WakeQueueService = wakeQueueServiceForAgent(agentId),
    private readonly activity: ActivityService = activityServiceForAgent(agentId),
  ) {}

  async saveAsk(record: InteractiveAskRecord): Promise<InteractiveAskRecord> {
    const ask = await this.store.create(record);
    await this.pruneOldAnswered();
    return ask;
  }

  async getAsk(askId: string): Promise<InteractiveAskRecord | undefined> {
    return this.store.find(askId);
  }

  async answerAsk(input: InteractiveAskAnswerInput): Promise<InteractiveAskAnswerResult> {
    const now = nowIso();
    let result: InteractiveAskAnswerResult = { outcome: 'not_found' };
    const existingAsk = await this.store.find(input.askId);
    const answeredBy = existingAsk
      && existingAsk.options.some((option) => option.optionId === input.optionId)
      && this.canUserAnswer(existingAsk, input.userId)
      && existingAsk.status === 'pending'
      ? await this.answeringUser(input, existingAsk)
      : undefined;

    await this.store.update(input.askId, (current) => {
      const touchedAsk = { ...current, lastInteractionAt: now };
      const option = current.options.find((candidate) => candidate.optionId === input.optionId);
      if (!option) {
        result = { ask: touchedAsk, outcome: 'invalid_option' };
      } else if (!this.canUserAnswer(current, input.userId)) {
        result = { ask: touchedAsk, outcome: 'forbidden' };
      } else if (current.status === 'answered') {
        result = { ask: touchedAsk, outcome: 'already_answered' };
      } else {
        result = {
          ask: {
            ...touchedAsk,
            answeredAt: now,
            answeredBy: answeredBy ?? { slackUserId: input.userId },
            chosenOptionId: option.optionId,
            deliveryPending: true,
            status: 'answered',
          },
          outcome: 'answered',
        };
      }
      return result.ask!;
    });

    if (result.ask && (result.outcome === 'answered' || result.outcome === 'already_answered')) {
      result.queued = await this.deliverAnswer(result.ask);
    }
    const extra: Record<string, unknown> = {};
    if (result.queued !== undefined) extra.queued = result.queued;
    if (result.outcome === 'answered') {
      extra.optionLabel = result.ask?.options.find((option) => option.optionId === result.ask?.chosenOptionId)?.label;
    }
    await this.recordAnswerActivity(input.askId, input.optionId, input.userId, result.outcome, extra);
    await this.pruneOldAnswered();
    return result;
  }

  async retryPendingAnswers(): Promise<void> {
    for (const ask of await this.store.list()) {
      if (!ask.deliveryPending) continue;
      try {
        await this.deliverAnswer(ask);
      } catch (error) {
        console.warn(`Interactive ask delivery failed for ${ask.askId}: ${errorMessage(error)}`);
      }
    }
  }

  private async deliverAnswer(ask: InteractiveAskRecord): Promise<boolean> {
    if (!ask.deliveryPending) return false;
    const selected = ask.options.find((option) => option.optionId === ask.chosenOptionId);
    if (ask.status !== 'answered' || !selected || !ask.answeredBy) {
      throw new Error(`Interactive ask ${ask.askId} has an invalid pending answer`);
    }
    // The chosen answer is immutable. A crash after enqueue but before clearing
    // the intent retries the same choice id through the queue's durable dedupe.
    const queued = !(await this.queue.enqueue(choiceResponseInboxItem(ask, selected, ask.answeredBy))).duplicate;
    await this.store.update(ask.askId, (current) => {
      if (!current.deliveryPending) return current;
      const { deliveryPending: _pending, ...delivered } = current;
      return delivered;
    });
    return queued;
  }

  async replaceAnsweredMessage(input: {
    ask: InteractiveAskRecord;
    client: WebClient;
  }): Promise<void> {
    const option = input.ask.options.find((candidate) => candidate.optionId === input.ask.chosenOptionId);
    const userId = input.ask.answeredBy?.slackUserId;
    if (!option || !userId) return;
    await input.client.chat.update({
      ...SLACK_NO_UNFURL,
      blocks: [
        // Mirror the question post: `markdown` block, same transform (GFM
        // bold is **, not mrkdwn's single *).
        {
          type: 'markdown',
          text: slackMarkdownBlockText(
            `${input.ask.question}\n\n✓ **${option.label}** — chosen by <@${userId}>`,
          ),
        },
      ],
      channel: input.ask.channelId,
      text: `${input.ask.question}\n\n✓ ${option.label} — chosen by <@${userId}>`,
      ts: input.ask.messageTs,
    });
  }

  async notifyForbiddenClick(input: {
    ask: InteractiveAskRecord;
    client: WebClient;
    userId: string;
  }): Promise<void> {
    const allowed = input.ask.allowedUserIds?.[0];
    if (!allowed) return;
    await input.client.chat.postEphemeral({
      ...SLACK_NO_UNFURL,
      channel: input.ask.channelId,
      text: `Only <@${allowed}> can answer this ask.`,
      user: input.userId,
    });
  }

  private canUserAnswer(ask: InteractiveAskRecord, userId: string): boolean {
    return !ask.allowedUserIds?.length || ask.allowedUserIds.includes(userId);
  }

  private async answeringUser(input: InteractiveAskAnswerInput, ask: InteractiveAskRecord): Promise<{
    displayName?: string;
    handle?: string;
    slackUserId: string;
  }> {
    const user = await new SlackWorkspaceDirectoryService({
      client: input.client,
      teamId: ask.teamId,
    }).getUser(input.userId).catch(() => undefined);
    return slackAnswerUser(user, input.userId);
  }

  private async recordAnswerActivity(
    askId: string,
    optionId: string,
    userId: string,
    outcome: InteractiveAskAnswerResult['outcome'],
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.activity.record({
      type: 'anima.ask.answer',
      payload: {
        askId,
        optionId,
        outcome,
        userId,
        ...(extra ?? {}),
      },
    }).catch(() => undefined);
  }

  private async pruneOldAnswered(): Promise<void> {
    try {
      const cutoffIso = new Date(Date.now() - INTERACTIVE_ASK_ANSWERED_RETENTION_MS).toISOString();
      await this.store.pruneAnsweredBefore(cutoffIso);
    } catch (error) {
      console.warn(`Interactive ask retention failed: ${errorMessage(error)}`);
    }
  }
}

export function interactiveAskServiceForAgent(agentId: string): InteractiveAskService {
  return new InteractiveAskService(agentId);
}

export function choiceResponseInboxItem(
  ask: InteractiveAskRecord,
  option: InteractiveAskOption,
  answeredBy: NonNullable<InteractiveAskRecord['answeredBy']>,
): ChoiceResponseInboxItem {
  const now = ask.answeredAt ?? nowIso();
  const threadTs = ask.threadTs ?? ask.messageTs;
  return {
    answeredBy,
    askId: ask.askId,
    channelId: ask.channelId,
    ...(ask.channelName ? { channelName: ask.channelName } : {}),
    handling: { createdAt: now, queuedAt: now, status: 'queued', updatedAt: now },
    id: `choice:${ask.agentId}:${ask.askId}`,
    kind: 'choice_response',
    messageTs: ask.messageTs,
    optionId: option.optionId,
    optionLabel: option.label,
    question: ask.question,
    receivedAt: now,
    teamId: ask.teamId,
    threadTs,
  };
}

export function slackAnswerUser(user: SlackUserInfo | undefined, fallback: string): {
  displayName?: string;
  handle?: string;
  slackUserId: string;
} {
  const displayName =
    user?.displayName?.trim()
    || user?.realName?.trim()
    || user?.name?.trim()
    || undefined;
  const handle = user?.name?.trim() || undefined;
  return {
    ...(displayName ? { displayName } : {}),
    ...(handle ? { handle } : {}),
    slackUserId: user?.id ?? fallback,
  };
}
