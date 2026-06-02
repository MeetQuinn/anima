import type { MessageTransportKind } from '../../shared/message-transport.js';

export interface MessageTransport {
  kind: MessageTransportKind;
  // start() should clean up its own partial setup if it throws. stop() should
  // be idempotent because runners may call it after partial-start failures.
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class MessageTransportRunner {
  private started: MessageTransport[] = [];

  constructor(private readonly transports: readonly MessageTransport[]) {}

  async start(): Promise<void> {
    const started: MessageTransport[] = [];
    try {
      for (const transport of this.transports) {
        await transport.start();
        started.push(transport);
      }
      this.started = started;
    } catch (error) {
      await Promise.allSettled([...started].reverse().map((transport) => transport.stop()));
      this.started = [];
      throw error;
    }
  }

  async stop(): Promise<void> {
    const transports = this.started.length ? this.started : [...this.transports];
    this.started = [];
    await Promise.allSettled([...transports].reverse().map((transport) => transport.stop()));
  }
}
