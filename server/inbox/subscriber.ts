import { WakeQueueService } from './wake-queue.service.js';
import { ReminderInboxSubscriber } from './reminder-subscriber.js';
import { MessageTransportRunner } from '../transports/message-transport.js';
import { SlackMessageTransport } from '../transports/slack-message-transport.js';

export interface InboxSubscriberOptions {
  agentRuntimeKind: string;
  appToken: string;
  botToken: string;
  queue: WakeQueueService;
}

export class InboxSubscriber {
  private readonly reminders: ReminderInboxSubscriber;
  private readonly transports: MessageTransportRunner;

  constructor(options: InboxSubscriberOptions) {
    this.reminders = new ReminderInboxSubscriber(options.queue);
    this.transports = new MessageTransportRunner([
      new SlackMessageTransport(options),
    ]);
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
