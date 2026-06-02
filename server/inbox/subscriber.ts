import { WakeQueueService } from './wake-queue.service.js';
import { ReminderInboxSubscriber } from './reminder-subscriber.js';
import type { FeishuConfig } from '../../shared/agent-config.js';
import { FeishuMessageTransport } from '../transports/feishu-message-transport.js';
import { MessageTransportRunner } from '../transports/message-transport.js';
import { SlackMessageTransport } from '../transports/slack-message-transport.js';

export interface InboxSubscriberOptions {
  agentRuntimeKind: string;
  appToken: string;
  botToken: string;
  feishu?: FeishuConfig;
  queue: WakeQueueService;
}

export class InboxSubscriber {
  private readonly reminders: ReminderInboxSubscriber;
  private readonly transports: MessageTransportRunner;

  constructor(options: InboxSubscriberOptions) {
    this.reminders = new ReminderInboxSubscriber(options.queue);
    this.transports = new MessageTransportRunner(
      [
        new SlackMessageTransport(options),
        ...(options.feishu?.connected ? [new FeishuMessageTransport({
          agentRuntimeKind: options.agentRuntimeKind,
          config: options.feishu,
          queue: options.queue,
        })] : []),
      ],
    );
  }

  async start(): Promise<void> {
    this.reminders.start();
    try {
      await this.transports.start();
    } catch (error) {
      await this.reminders.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled([
      this.transports.stop(),
      this.reminders.stop(),
    ]);
  }
}
