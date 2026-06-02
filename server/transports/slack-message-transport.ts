import { SlackInboxSubscriber, type SlackInboxSubscriberOptions } from '../inbox/slack-subscriber.js';
import type { MessageTransport } from './message-transport.js';

export class SlackMessageTransport implements MessageTransport {
  readonly kind = 'slack';
  private readonly subscriber: SlackInboxSubscriber;

  constructor(options: SlackInboxSubscriberOptions) {
    this.subscriber = new SlackInboxSubscriber(options);
  }

  async start(): Promise<void> {
    await this.subscriber.start();
  }

  async stop(): Promise<void> {
    await this.subscriber.stop();
  }
}
