import { createFeishuEventDispatcher, createFeishuWsClient } from '../feishu/client.js';
import { feishuReceiveMessageEventFromData, normalizeFeishuMessage } from '../feishu/events.js';
import { WakeQueueService, type WakeQueueEnqueueResult } from '../inbox/wake-queue.service.js';
import type { FeishuConfig } from '../../shared/agent-config.js';
import type { FeishuInboxItem } from '../../shared/inbox.js';
import type { MessageTransport } from './message-transport.js';

interface FeishuWsClient {
  close(params?: { force?: boolean }): void;
  start(params: { eventDispatcher: unknown }): Promise<void>;
}

export interface FeishuMessageTransportOptions {
  agentRuntimeKind: string;
  config: FeishuConfig;
  queue: WakeQueueService;
}

export interface FeishuMessageTransportDeps {
  createWsClient?(config: FeishuConfig): FeishuWsClient;
}

export class FeishuMessageTransport implements MessageTransport {
  readonly kind = 'feishu';
  private wsClient?: FeishuWsClient;

  constructor(
    private readonly options: FeishuMessageTransportOptions,
    private readonly deps: FeishuMessageTransportDeps = {},
  ) {}

  async start(): Promise<void> {
    const wsClient = this.deps.createWsClient?.(this.options.config) ?? createFeishuWsClient(this.options.config);
    const dispatcher = createFeishuEventDispatcher({
      config: this.options.config,
      onReceiveMessage: (data) => this.handleReceiveMessage(data),
    });
    try {
      await wsClient.start({ eventDispatcher: dispatcher });
      this.wsClient = wsClient;
    } catch (error) {
      wsClient.close({ force: true });
      this.wsClient = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.wsClient?.close({ force: true });
    this.wsClient = undefined;
  }

  private async handleReceiveMessage(data: unknown): Promise<void> {
    const receiveEvent = feishuReceiveMessageEventFromData(data);
    if (!receiveEvent) {
      console.log(JSON.stringify(feishuIgnoredLog(this.options.agentRuntimeKind), null, 2));
      return;
    }
    const event = normalizeFeishuMessage({
      appId: this.options.config.appId,
      botOpenId: this.options.config.botOpenId,
      event: receiveEvent,
    });
    if (!event) {
      console.log(JSON.stringify(feishuIgnoredLog(this.options.agentRuntimeKind), null, 2));
      return;
    }
    const decision = await this.options.queue.enqueue(event);
    console.log(JSON.stringify(feishuDecisionLog(decision, this.options.agentRuntimeKind), null, 2));
  }
}

function feishuDecisionLog(
  decision: WakeQueueEnqueueResult,
  agentRuntimeKind: string,
): object {
  return {
    agentRuntime: agentRuntimeKind,
    duplicate: Boolean(decision.duplicate),
    ingested: !decision.duplicate,
    itemId: decision.item.id,
    platform: 'feishu',
    queued: Boolean(decision.queued),
    surface: isFeishuItem(decision.item) ? {
      chatId: decision.item.chatId,
      chatType: decision.item.chatType,
      ...(decision.item.threadId ? { threadId: decision.item.threadId } : {}),
    } : undefined,
  };
}

function feishuIgnoredLog(agentRuntimeKind: string): object {
  return {
    agentRuntime: agentRuntimeKind,
    ignored: true,
    ingested: false,
    platform: 'feishu',
    reason: 'not_addressed_or_unsupported',
  };
}

function isFeishuItem(item: unknown): item is FeishuInboxItem {
  return Boolean(item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'feishu');
}
