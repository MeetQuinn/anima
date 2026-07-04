import { App, LogLevel } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';

import { WakeReason, type SlackInboxItem } from '../../shared/inbox.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { interactiveAskServiceForAgent } from '../asks/interactive-ask.service.js';
import { errorMessage, slackMessageEventId } from '../ids.js';
import { createSlackWebClient } from '../slack/client.js';
import {
  SlackShortcutService,
  userIdFromShortcutBody,
  type SlackShortcutBody,
} from '../slack-interactions/shortcut.service.js';
import {
  SLACK_STOP_CONFIRM_VIEW_CALLBACK_ID,
  SLACK_VIEW_REMINDER_DETAIL_ACTION_ID,
  SLACK_VIEW_REMINDERS_ACTION_ID,
} from '../slack-interactions/shortcut-ids.js';
import { SlackWorkspaceDirectoryService, type SlackWorkspaceDirectoryEvent } from '../slack/workspace-directory.service.js';
import { SlackProfileResolver } from '../slack/profiles.js';
import {
  isSlackEvent,
  isRoutableSlackMessage,
  slackEventTeamId,
  slackSurfaceForEvent,
  type SlackMessageEnvelope,
  type SlackRawMessageEvent,
} from './slack-events.js';
import {
  recordAttentionSuggestionActivity,
  slackAttentionSuggestionPayload,
} from './attention-suggestion-activity.js';
import { buildSlackInboxItem } from './slack-ingest.js';
import { slackShortcutHandoffServiceForAgent } from './slack-shortcut-handoff.service.js';
import { slackRuntimeDecision, type SlackRuntimeDecision } from './slack-subscription.service.js';
import { WakeQueueService, type WakeQueueEnqueueResult } from './wake-queue.service.js';

export interface SlackInboxSubscriberOptions {
  agentRuntimeKind: string;
  appToken: string;
  botToken: string;
  queue: WakeQueueService;
}

export class SlackInboxSubscriber {
  private readonly app: App;
  private readonly shortcutService: SlackShortcutService;
  private readonly slackProfiles = new SlackProfileResolver();
  // Guards the fire-and-forget bot display-info refresh so overlapping inbound
  // messages don't trigger concurrent syncs.
  private botDisplayInfoSyncInFlight = false;

  constructor(private readonly options: SlackInboxSubscriberOptions) {
    this.shortcutService = new SlackShortcutService({
      handoffService: slackShortcutHandoffServiceForAgent(options.queue.agentId),
    });
    this.app = this.createApp();
  }

  async start(): Promise<void> {
    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop().catch((error: unknown) => {
      console.error(`Slack app stop failed: ${errorMessage(error)}`);
    });
  }

  private createApp(): App {
    const app = new App({
      appToken: this.options.appToken,
      ignoreSelf: true,
      logLevel: LogLevel.INFO,
      socketMode: true,
      token: this.options.botToken,
    });
    app.message(async ({ body, client, event }) => {
      await this.handleSlackEvent(body, event, client);
    });
    app.event('app_mention', async ({ body, client, event }) => {
      await this.handleSlackEvent(body, event, client);
    });
    app.action(/^anima\.ask\.answer/, async ({ ack, action, body, client }) => {
      await ack();
      await this.handleInteractiveAskAction(body, action, client);
    });
    app.action(SLACK_VIEW_REMINDERS_ACTION_ID, async ({ ack, body, client }) => {
      await ack();
      const triggerId = (body as { trigger_id?: string }).trigger_id;
      if (!triggerId) return;
      await this.shortcutService.showRemindersView({
        agentId: this.options.queue.agentId,
        client,
        triggerId,
      });
    });
    app.action(SLACK_VIEW_REMINDER_DETAIL_ACTION_ID, async ({ ack, action, body, client }) => {
      await ack();
      const triggerId = (body as { trigger_id?: string }).trigger_id;
      const reminderId = (action as { value?: string }).value;
      if (!triggerId || !reminderId) return;
      await this.shortcutService.showReminderDetailView({
        agentId: this.options.queue.agentId,
        client,
        reminderId,
        triggerId,
      });
    });
    app.shortcut({
      callback_id: 'anima.home',
      type: 'shortcut',
    }, async ({ ack, body, client }) => {
      await ack();
      await this.handleGlobalShortcut(body, client);
    });
    app.shortcut({
      callback_id: 'anima.hand_to_agent',
      type: 'message_action',
    }, async ({ ack, body }) => {
      await ack();
      await this.handleMessageShortcut(body);
    });
    app.view({
      callback_id: SLACK_STOP_CONFIRM_VIEW_CALLBACK_ID,
      type: 'view_submission',
    }, async ({ ack, body, view }) => {
      const resultView = await this.shortcutService.confirmStop({
        agentId: this.options.queue.agentId,
        userId: userIdFromShortcutBody(body),
        view,
      });
      await ack({
        response_action: 'update',
        view: resultView,
      });
    });
    for (const eventName of SLACK_DIRECTORY_EVENTS) {
      app.event(eventName, async ({ body, client, event }) => {
        await this.handleSlackWorkspaceDirectoryEvent(body, event, client);
      });
    }
    return app;
  }

  private async handleGlobalShortcut(body: unknown, client?: WebClient): Promise<void> {
    const webClient = client ?? createSlackWebClient(this.options.botToken);
    await this.shortcutService.handleShortcut({
      agentId: this.options.queue.agentId,
      body: body as SlackShortcutBody,
      client: webClient,
    });
  }

  private async handleMessageShortcut(body: unknown): Promise<void> {
    await this.shortcutService.handMessageToAgent({
      agentId: this.options.queue.agentId,
      body: body as SlackShortcutBody,
    });
  }

  private async handleInteractiveAskAction(body: unknown, action: unknown, client?: WebClient): Promise<void> {
    const value = interactiveAskActionValue(action);
    const userId = interactiveAskUserId(body);
    if (!value || !userId) {
      console.warn('Interactive ask action missing value or user id');
      return;
    }
    const webClient = client ?? createSlackWebClient(this.options.botToken);
    const askService = interactiveAskServiceForAgent(this.options.queue.agentId);
    const result = await askService.answerAsk({
      askId: value.askId,
      client: webClient,
      optionId: value.optionId,
      userId,
    });
    if (result.outcome === 'answered' && result.ask) {
      await askService.replaceAnsweredMessage({
        ask: result.ask,
        client: webClient,
      }).catch((error: unknown) => {
        console.warn(`Interactive ask message update failed: ${errorMessage(error)}`);
      });
    }
    if (result.outcome === 'forbidden' && result.ask) {
      await askService.notifyForbiddenClick({
        ask: result.ask,
        client: webClient,
        userId,
      }).catch((error: unknown) => {
        console.warn(`Interactive ask forbidden notice failed: ${errorMessage(error)}`);
      });
    }
    console.log(JSON.stringify({
      agentRuntime: this.options.agentRuntimeKind,
      askId: value.askId,
      interactiveAsk: true,
      optionId: value.optionId,
      outcome: result.outcome,
      queued: Boolean(result.queued),
      userId,
    }, null, 2));
  }

  private async handleSlackWorkspaceDirectoryEvent(body: unknown, event: unknown, client?: WebClient): Promise<void> {
    const envelope = body as SlackMessageEnvelope;
    const rawEvent = event as SlackWorkspaceDirectoryEvent;
    const webClient = client ?? createSlackWebClient(this.options.botToken);
    await new SlackWorkspaceDirectoryService({
      client: webClient,
      teamId: envelope.team_id ?? rawEvent.team,
    }).applyEvent(rawEvent).catch((error: unknown) => {
      console.warn(`Slack directory cache update failed: ${errorMessage(error)}`);
    });
  }

  private async handleSlackEvent(body: unknown, event: unknown, client?: WebClient): Promise<void> {
    const rawEvent = event as SlackRawMessageEvent;
    if (!isRoutableSlackMessage(rawEvent)) return;

    const envelope = body as SlackMessageEnvelope;
    const teamId = slackEventTeamId(envelope, rawEvent);
    const duplicate = Boolean(await this.options.queue.hasSeen(
      slackMessageEventId(teamId, rawEvent.channel, rawEvent.ts),
    ));
    const runtimeDecision = await slackRuntimeDecision(rawEvent, { agentId: this.options.queue.agentId, duplicate });
    if (!runtimeDecision.shouldStartRuntime) {
      console.log(JSON.stringify(slackIgnoredLog(rawEvent, this.options.agentRuntimeKind, runtimeDecision.reason), null, 2));
      return;
    }

    const webClient = client ?? createSlackWebClient(this.options.botToken);
    this.maybeSyncBotDisplayInfo(webClient);
    const item = await buildSlackInboxItem({
      ...(runtimeDecision.attentionSuggestion ? { attentionSuggestion: runtimeDecision.attentionSuggestion } : {}),
      client: webClient,
      envelope,
      event: rawEvent,
      profiles: this.slackProfiles,
    });
    const decision = await this.options.queue.enqueue(withSlackWakeReason(item, runtimeDecision.reason));
    if (runtimeDecision.attentionSuggestion && !decision.duplicate) {
      await recordAttentionSuggestionActivity(
        this.options.queue.agentId,
        slackAttentionSuggestionPayload(item, runtimeDecision.attentionSuggestion),
      );
    }
    if (runtimeDecision.reason === 'mention' && runtimeDecision.subscription && !decision.duplicate) {
      activityServiceForAgent(this.options.queue.agentId).record({
        type: 'anima.subscription.add',
        payload: {
          channelId: item.channelId,
          ...(item.channelName ? { channelName: item.channelName } : {}),
          kind: runtimeDecision.subscription.kind,
        },
      }).catch((err: unknown) => console.warn(`subscription.add activity: ${errorMessage(err)}`));
    }
    console.log(JSON.stringify(slackDecisionLog(decision, this.options.agentRuntimeKind, runtimeDecision), null, 2));
  }

  // Opportunistically refresh the bot's own display info (avatar, name,
  // workspace icon) while we're already handling a message. Throttled to once
  // per TTL by the service, fire-and-forget so it never blocks or fails message
  // routing, and guarded against overlapping runs within this process.
  private maybeSyncBotDisplayInfo(client: WebClient): void {
    if (this.botDisplayInfoSyncInFlight) return;
    this.botDisplayInfoSyncInFlight = true;
    agentSlackServiceForAgent(this.options.queue.agentId)
      .syncDisplayInfoIfStale({ client, ttlMs: BOT_DISPLAY_INFO_SYNC_TTL_MS })
      .catch((error: unknown) => {
        console.warn(`bot display-info sync failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.botDisplayInfoSyncInFlight = false;
      });
  }
}

function withSlackWakeReason(
  item: SlackInboxItem,
  reason: SlackRuntimeDecision['reason'],
): SlackInboxItem {
  const parsed = WakeReason.safeParse(reason);
  return parsed.success ? { ...item, wakeReason: parsed.data } : item;
}

// Refresh the bot's own Slack display info at most once every 6h while handling
// messages — frequent enough to pick up an avatar/name change soon after it
// happens, rare enough to add no meaningful Slack API load.
const BOT_DISPLAY_INFO_SYNC_TTL_MS = 6 * 60 * 60 * 1000;

const SLACK_DIRECTORY_EVENTS = [
  'channel_archive',
  'channel_created',
  'channel_deleted',
  'channel_rename',
  'channel_unarchive',
  'team_join',
  'user_change',
] as const;

function slackDecisionLog(
  decision: WakeQueueEnqueueResult,
  agentRuntimeKind: string,
  runtimeDecision?: SlackRuntimeDecision,
): object {
  return {
    agentRuntime: agentRuntimeKind,
    duplicate: Boolean(decision.duplicate),
    ...(runtimeDecision?.subscription ? { subscription: runtimeDecision.subscription } : {}),
    ingested: !decision.duplicate,
    queued: Boolean(decision.queued),
    reason: runtimeDecision?.reason,
    itemId: decision.item.id,
    surface: isSlackEvent(decision.item)
      ? slackSurfaceForEvent(decision.item)
      : undefined,
  };
}

function slackIgnoredLog(event: SlackRawMessageEvent, agentRuntimeKind: string, reason = 'not_addressed'): object {
  return {
    agentRuntime: agentRuntimeKind,
    channel: event.channel,
    ignored: true,
    ingested: false,
    reason,
    ts: event.ts,
  };
}

function interactiveAskActionValue(action: unknown): { askId: string; optionId: string } | undefined {
  if (!isRecord(action) || typeof action['value'] !== 'string') return undefined;
  try {
    const value = JSON.parse(action['value']) as unknown;
    if (!isRecord(value) || typeof value['askId'] !== 'string' || typeof value['optionId'] !== 'string') {
      return undefined;
    }
    return { askId: value['askId'], optionId: value['optionId'] };
  } catch {
    return undefined;
  }
}

function interactiveAskUserId(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const user = body['user'];
  if (isRecord(user) && typeof user['id'] === 'string') return user['id'];
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
