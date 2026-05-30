import type { WebClient } from '@slack/web-api';

import type { AgentConfig } from '../../shared/agent-config.js';
import type { AgentStatusSummary } from '../../shared/snapshot.js';
import { defaultActivityRecorder, type ActivityRecorder } from '../activities/activity.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { nowIso } from '../ids.js';
import { WakeQueueService, type InboxItem } from '../inbox/wake-queue.service.js';
import { reminderServiceForAgent, type ReminderService } from '../reminders/reminder.service.js';
import { defaultRuntimeService, RuntimeServiceError } from '../runtime/runtime.service.js';
import { escapeMrkdwn, homeView, reminderDetailView, remindersView, shortcutModal } from './shortcut-views.js';
import type { ShortcutModalInput, ShortcutModalView } from './shortcut-views.js';

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

export interface SlackShortcutView {
  private_metadata?: string;
}

interface ShortcutRuntimeService {
  getStatus(agentId: string): Promise<AgentStatusSummary>;
  stopCurrentItem(agentId: string): Promise<void>;
}

interface ShortcutAgentService {
  serviceFor(agentId: string): {
    getConfig(): Promise<AgentConfig>;
  };
}

type ReminderServiceFactory = (agentId: string) => ReminderService;

interface SlackShortcutServiceDeps {
  activityRecorder?: ActivityRecorder;
  agentService?: ShortcutAgentService;
  now?: () => Date;
  reminderServiceForAgent?: ReminderServiceFactory;
  runtimeService?: ShortcutRuntimeService;
}

interface StopConfirmMetadata {
  itemId?: string;
}

export class SlackShortcutService {
  private readonly activityRecorder: ActivityRecorder;
  private readonly agentService: ShortcutAgentService;
  private readonly now: () => Date;
  private readonly reminderServiceForAgent: ReminderServiceFactory;
  private readonly runtimeService: ShortcutRuntimeService;

  constructor(deps: SlackShortcutServiceDeps = {}) {
    this.activityRecorder = deps.activityRecorder ?? defaultActivityRecorder;
    this.agentService = deps.agentService ?? defaultAgentRegistryService;
    this.now = deps.now ?? (() => new Date());
    this.reminderServiceForAgent = deps.reminderServiceForAgent ?? reminderServiceForAgent;
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

  async confirmStop(input: {
    agentId: string;
    userId?: string;
    view: SlackShortcutView;
  }): Promise<ShortcutModalView> {
    const status = await this.runtimeService.getStatus(input.agentId);
    const metadata = stopConfirmMetadata(input.view);
    if (!status.currentItemId) {
      await this.recordShortcutActivity(input.agentId, 'anima.shortcut.stop', {
        outcome: 'idle',
        userId: input.userId,
      });
      return shortcutModal({
        title: 'Nothing running',
        lines: ['This agent is idle. No current turn was stopped.'],
      });
    }
    if (metadata.itemId && metadata.itemId !== status.currentItemId) {
      await this.recordShortcutActivity(input.agentId, 'anima.shortcut.stop', {
        currentItemId: status.currentItemId,
        requestedItemId: metadata.itemId,
        outcome: 'item_changed',
        userId: input.userId,
      });
      return shortcutModal({
        title: 'Item changed',
        lines: [
          'The current turn changed after this confirmation opened.',
          'Open Stop again to interrupt the new current turn.',
        ],
      });
    }

    try {
      await this.runtimeService.stopCurrentItem(input.agentId);
    } catch (error) {
      if (!(error instanceof RuntimeServiceError) || error.statusCode !== 409) throw error;
      await this.recordShortcutActivity(input.agentId, 'anima.shortcut.stop', {
        outcome: 'idle',
        userId: input.userId,
      });
      return shortcutModal({
        title: 'Nothing running',
        lines: ['This agent became idle before Stop was applied.'],
      });
    }
    await this.recordShortcutActivity(input.agentId, 'anima.shortcut.stop', {
      itemId: status.currentItemId,
      outcome: 'stop_requested',
      userId: input.userId,
    });
    return shortcutModal({
      title: 'Stop requested',
      lines: [
        `Requested stop for current item \`${escapeMrkdwn(status.currentItemId)}\`.`,
      ],
    });
  }

  /** Handles the "View all reminders" button — pushes a read-only reminder list. */
  async showRemindersView(input: {
    agentId: string;
    triggerId: string;
    client: WebClient;
  }): Promise<void> {
    const reminders = await this.reminderServiceForAgent(input.agentId).listReminders({
      statuses: ['scheduled'],
    });
    await input.client.views.push({
      trigger_id: input.triggerId,
      view: remindersView(reminders, this.now()),
    });
  }

  /** Handles a per-reminder "View →" button — pushes a single-reminder detail view. */
  async showReminderDetailView(input: {
    agentId: string;
    reminderId: string;
    triggerId: string;
    client: WebClient;
  }): Promise<void> {
    const reminders = await this.reminderServiceForAgent(input.agentId).listReminders({
      statuses: ['scheduled'],
    });
    const reminder = reminders.find((r) => r.reminderId === input.reminderId);
    if (!reminder) return; // reminder cancelled or not found — silently ignore
    await input.client.views.push({
      trigger_id: input.triggerId,
      view: reminderDetailView(reminder, this.now()),
    });
  }

  private async showHome(input: { agentId: string; body: SlackShortcutBody; client: WebClient }): Promise<void> {
    const [agent, status, reminders] = await Promise.all([
      this.agentService.serviceFor(input.agentId).getConfig(),
      this.runtimeService.getStatus(input.agentId),
      this.reminderServiceForAgent(input.agentId).listReminders({ statuses: ['scheduled'] }),
    ]);
    if (!input.body.trigger_id) return;
    await input.client.views.open({
      trigger_id: input.body.trigger_id,
      view: homeView(agent, status, reminders, this.now()),
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
    const now = nowIso();
    const threadTs = message.thread_ts ?? message.ts;
    const item: InboxItem = {
      actor: {
        ...(message.user ? { userId: message.user } : {}),
      },
      channelId,
      ...(input.body.channel?.name ? { channelName: input.body.channel.name } : {}),
      handling: { createdAt: now, queuedAt: now, status: 'queued', updatedAt: now },
      id: `slack-shortcut-handoff:${teamId}:${channelId}:${message.ts}`,
      kind: 'slack',
      messageTs: message.ts,
      receivedAt,
      teamId,
      text: handoffText(message.text ?? '', input.body.user?.id),
      threadTs,
    };
    const result = await new WakeQueueService(input.agentId).enqueue(item);
    await this.recordShortcutActivity(input.agentId, 'anima.shortcut.handoff', {
      channelId,
      duplicate: result.duplicate,
      itemId: result.item.id,
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

export const defaultSlackShortcutService = new SlackShortcutService();

export function userIdFromShortcutBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const user = body['user'];
  return isRecord(user) && typeof user['id'] === 'string' ? user['id'] : undefined;
}

function slackTsToIsoOrNow(ts: string): string {
  const seconds = Number(ts.split('.')[0]);
  if (!Number.isFinite(seconds)) return nowIso();
  return new Date(seconds * 1000).toISOString();
}

function stopConfirmMetadata(view: SlackShortcutView): StopConfirmMetadata {
  if (!view.private_metadata) return {};
  try {
    const parsed = JSON.parse(view.private_metadata) as unknown;
    if (!isRecord(parsed)) return {};
    const itemId = typeof parsed['itemId'] === 'string' ? parsed['itemId'] : undefined;
    return itemId ? { itemId } : {};
  } catch {
    return {};
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
