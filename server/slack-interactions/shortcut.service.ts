import type { WebClient } from '@slack/web-api';

import type { AgentConfig } from '../../shared/agent-config.js';
import type { AgentStatusSummary } from '../../shared/snapshot.js';
import { defaultActivityRecorder, type ActivityRecorder } from '../activities/activity.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { nowIso } from '../ids.js';
import { defaultRuntimeService } from '../runtime/runtime.service.js';
import { homeView, shortcutModal } from './shortcut-views.js';
import type { ShortcutModalInput } from './shortcut-views.js';

export type { ShortcutModalView } from './shortcut-views.js';

export interface SlackShortcutUser {
  id: string;
  name?: string;
  team_id?: string;
  username?: string;
}

export interface SlackShortcutBody {
  callback_id?: string;
  channel?: { id?: string; name?: string };
  message?: {
    text?: string;
    thread_ts?: string;
    ts?: string;
    user?: string;
  };
  response_url?: string;
  team?: { id?: string } | null;
  trigger_id?: string;
  type?: string;
  user?: SlackShortcutUser;
}

interface ShortcutRuntimeService {
  getStatus(agentId: string): Promise<AgentStatusSummary>;
}

interface ShortcutAgentService {
  serviceFor(agentId: string): {
    getConfig(): Promise<AgentConfig>;
  };
}

export interface SlackShortcutHandoffInput {
  channelId: string;
  channelName?: string;
  /** User who invoked the shortcut (body.user); fallback actor when source omits user. */
  invokerUserId?: string;
  messageTs: string;
  receivedAt: string;
  /** Author of the source message when Slack provides message.user. */
  sourceUserId?: string;
  teamId: string;
  text: string;
  threadTs: string;
}

export interface SlackShortcutHandoffResult {
  duplicate: boolean;
  itemId: string;
  queued: boolean;
}

export interface SlackShortcutHandoffService {
  handMessageToAgent(input: SlackShortcutHandoffInput): Promise<SlackShortcutHandoffResult>;
}

interface SlackShortcutServiceDeps {
  activityRecorder?: ActivityRecorder;
  agentService?: ShortcutAgentService;
  handoffService?: SlackShortcutHandoffService;
  now?: () => Date;
  runtimeService?: ShortcutRuntimeService;
}

export class SlackShortcutService {
  private readonly activityRecorder: ActivityRecorder;
  private readonly agentService: ShortcutAgentService;
  private readonly handoffService?: SlackShortcutHandoffService;
  private readonly now: () => Date;
  private readonly runtimeService: ShortcutRuntimeService;

  constructor(deps: SlackShortcutServiceDeps = {}) {
    this.activityRecorder = deps.activityRecorder ?? defaultActivityRecorder;
    this.agentService = deps.agentService ?? defaultAgentRegistryService;
    this.handoffService = deps.handoffService;
    this.now = deps.now ?? (() => new Date());
    this.runtimeService = deps.runtimeService ?? defaultRuntimeService;
  }

  async handleShortcut(input: {
    agentId: string;
    body: SlackShortcutBody;
    client: WebClient;
  }): Promise<void> {
    switch (input.body.callback_id) {
      case 'anima.home':
        await this.showHome(input);
        return;
      default:
        await this.openModal(input.client, input.body, {
          title: 'Shortcut unavailable',
          lines: ['This shortcut is not supported by this Anima build yet.'],
        });
    }
  }

  private async showHome(input: { agentId: string; body: SlackShortcutBody; client: WebClient }): Promise<void> {
    const [agent, status] = await Promise.all([
      this.agentService.serviceFor(input.agentId).getConfig(),
      this.runtimeService.getStatus(input.agentId),
    ]);
    if (!input.body.trigger_id) return;
    await input.client.views.open({
      trigger_id: input.body.trigger_id,
      view: homeView(agent, status, this.now()),
    });
  }

  async handMessageToAgent(input: {
    agentId: string;
    body: SlackShortcutBody;
  }): Promise<void> {
    const message = input.body.message;
    const channelId = input.body.channel?.id;
    const teamId = input.body.team?.id;
    if (!message?.ts || !channelId || !teamId) {
      await this.respondToMessageShortcut(input.body, { text: 'I could not read the source message for this handoff.' });
      return;
    }

    const receivedAt = slackTsToIsoOrNow(message.ts);
    const threadTs = message.thread_ts ?? message.ts;
    if (!this.handoffService) throw new Error('Slack shortcut handoff service is not configured');
    const result = await this.handoffService.handMessageToAgent({
      channelId,
      ...(input.body.channel?.name ? { channelName: input.body.channel.name } : {}),
      ...(input.body.user?.id ? { invokerUserId: input.body.user.id } : {}),
      messageTs: message.ts,
      receivedAt,
      ...(message.user ? { sourceUserId: message.user } : {}),
      teamId,
      text: handoffText(message.text ?? '', input.body.user?.id),
      threadTs,
    });
    await this.recordShortcutActivity(input.agentId, 'anima.shortcut.handoff', {
      channelId,
      duplicate: result.duplicate,
      itemId: result.itemId,
      messageTs: message.ts,
      queued: result.queued,
      threadTs,
      userId: input.body.user?.id,
    });
    await this.respondToMessageShortcut(input.body, {
      text: result.duplicate
        ? 'This message was already handed to the agent.'
        : 'Handed to the agent. It will reply in this thread.',
    });
  }

  private async openModal(client: WebClient, body: SlackShortcutBody, input: ShortcutModalInput): Promise<void> {
    if (!body.trigger_id) return;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: shortcutModal(input),
    });
  }

  private async respondToMessageShortcut(body: SlackShortcutBody, input: { text: string }): Promise<void> {
    if (!body.response_url) return;
    await fetch(body.response_url, {
      body: JSON.stringify({ response_type: 'ephemeral', text: input.text }),
      headers: { 'content-type': 'application/json; charset=utf-8' },
      method: 'POST',
    });
  }

  private async recordShortcutActivity(agentId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.activityRecorder.record(agentId, { type, payload });
  }
}

function slackTsToIsoOrNow(ts: string): string {
  const seconds = Number(ts.split('.')[0]);
  if (!Number.isFinite(seconds)) return nowIso();
  return new Date(seconds * 1000).toISOString();
}

function handoffText(text: string, handedByUserId: string | undefined): string {
  const body = text.trim() || '(message had no text)';
  return [
    handedByUserId
      ? `<@${handedByUserId}> used the Slack message shortcut to hand you this message as a task.`
      : 'A teammate used the Slack message shortcut to hand you this message as a task.',
    'Reply in this thread with your result.',
    '',
    body,
  ].join('\n');
}
