import type { WebClient } from '@slack/web-api';

import type { AgentOwner } from '../../shared/agent-config.js';
import type { ChoiceResponseInboxItem } from '../../shared/inbox.js';
import { activityServiceForAgent, type ActivityService } from '../activities/activity.service.js';
import { errorMessage, nowIso } from '../ids.js';
import { WakeQueueService, wakeQueueServiceForAgent } from '../inbox/wake-queue.service.js';
import { SlackWorkspaceDirectoryService, type SlackUserInfo } from '../slack/workspace-directory.service.js';
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

    if (existingAsk) {
      const touchedAsk = { ...existingAsk, lastInteractionAt: now };
      const option = existingAsk.options.find((candidate) => candidate.optionId === input.optionId);
      if (!option) {
        result = { ask: await this.store.update(touchedAsk), outcome: 'invalid_option' };
      } else if (!this.canUserAnswer(existingAsk, input.userId)) {
        result = { ask: await this.store.update(touchedAsk), outcome: 'forbidden' };
      } else if (existingAsk.status === 'answered') {
        result = { ask: await this.store.update(touchedAsk), outcome: 'already_answered' };
      } else {
        const answeredAsk: InteractiveAskRecord = {
          ...touchedAsk,
          answeredAt: now,
          answeredBy: answeredBy ?? { slackUserId: input.userId },
          chosenOptionId: option.optionId,
          status: 'answered',
        };
        result = { ask: await this.store.update(answeredAsk), outcome: 'answered' };
      }
    }

    if (result.outcome !== 'answered' || !result.ask) {
      await this.recordAnswerActivity(input.askId, input.optionId, input.userId, result.outcome);
      await this.pruneOldAnswered();
      return result;
    }

    const selected = result.ask.options.find((option) => option.optionId === result.ask?.chosenOptionId);
    if (!selected || !result.ask.answeredBy) {
      await this.recordAnswerActivity(input.askId, input.optionId, input.userId, 'invalid_option');
      await this.pruneOldAnswered();
      return { ask: result.ask, outcome: 'invalid_option' };
    }
    const queued = !(await this.queue.enqueue(choiceResponseInboxItem(result.ask, selected, result.ask.answeredBy))).duplicate;
    await this.recordAnswerActivity(input.askId, input.optionId, input.userId, 'answered', {
      queued,
      optionLabel: selected.label,
    });
    await this.pruneOldAnswered();
    return { ...result, queued };
  }

  async replaceAnsweredMessage(input: {
    ask: InteractiveAskRecord;
    client: WebClient;
  }): Promise<void> {
    const option = input.ask.options.find((candidate) => candidate.optionId === input.ask.chosenOptionId);
    const userId = input.ask.answeredBy?.slackUserId;
    if (!option || !userId) return;
    await input.client.chat.update({
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${input.ask.question}\n\n✓ *${option.label}* — chosen by <@${userId}>`,
          },
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
    user?.profile?.display_name?.trim()
    || user?.profile?.real_name?.trim()
    || user?.real_name?.trim()
    || user?.name?.trim()
    || undefined;
  const handle = user?.name?.trim() || undefined;
  return {
    ...(displayName ? { displayName } : {}),
    ...(handle ? { handle } : {}),
    slackUserId: user?.id ?? fallback,
  };
}

export function ownerAllowedUser(owner: AgentOwner): {
  displayName?: string;
  handle?: string;
  slackUserId: string;
} {
  return {
    displayName: owner.displayName,
    ...(owner.handle ? { handle: owner.handle } : {}),
    slackUserId: owner.slackUserId,
  };
}
