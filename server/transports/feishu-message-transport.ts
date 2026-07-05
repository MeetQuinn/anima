import { createFeishuEventDispatcher, createFeishuMessageClient, createFeishuWsClient } from '../feishu/client.js';
import { FeishuDirectoryService, feishuDirectoryId } from '../feishu/directory.service.js';
import {
  feishuMessageMentionsBot,
  feishuReactionEventFromData,
  feishuReceiveMessageEventFromData,
  normalizeFeishuMessage,
  normalizeFeishuReaction,
  type FeishuReceiveMessageEvent,
} from '../feishu/events.js';
import {
  feishuPostPlainTextFromContent,
  parseFeishuContent,
} from '../feishu/message-content.js';
import { agentFeishuServiceForAgent } from '../agents/agent-feishu.service.js';
import {
  feishuAttentionSuggestionPayload,
} from '../inbox/attention-suggestion-activity.js';
import { runIngestPipeline } from '../inbox/ingest-pipeline.js';
import { feishuRuntimeDecision, type FeishuRuntimeDecision } from '../inbox/slack-subscription.service.js';
import { WakeQueueService, type WakeQueueEnqueueResult } from '../inbox/wake-queue.service.js';
import type { FeishuConfig } from '../../shared/agent-config.js';
import type { FeishuInboxItem, FeishuQuotedMessage } from '../../shared/inbox.js';
import type { MessageTransport } from './message-transport.js';
import type { FeishuConversationMessage, FeishuMessageClient } from '../feishu/client.js';

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
  createMessageClient?(config: FeishuConfig): FeishuMessageClient;
  createWsClient?(config: FeishuConfig): FeishuWsClient;
}

export class FeishuMessageTransport implements MessageTransport {
  readonly kind = 'feishu';
  private readonly client: FeishuMessageClient;
  private displayInfoSyncInFlight = false;
  private wsClient?: FeishuWsClient;

  constructor(
    private readonly options: FeishuMessageTransportOptions,
    private readonly deps: FeishuMessageTransportDeps = {},
  ) {
    this.client = this.deps.createMessageClient?.(this.options.config) ?? createFeishuMessageClient(this.options.config);
  }

  async start(): Promise<void> {
    const wsClient = this.deps.createWsClient?.(this.options.config) ?? createFeishuWsClient(this.options.config);
    const dispatcher = createFeishuEventDispatcher({
      config: this.options.config,
      onReactionCreated: (data) => this.handleReactionCreated(data),
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
    let event = normalizeFeishuMessage({
      appId: this.options.config.appId,
      botOpenId: this.options.config.botOpenId,
      event: receiveEvent,
    });
    if (!event) {
      console.log(JSON.stringify(feishuIgnoredLog(this.options.agentRuntimeKind), null, 2));
      return;
    }
    await runIngestPipeline<FeishuInboxItem, FeishuRuntimeDecision>({
      agentId: this.options.queue.agentId,
      attentionSuggestionPayload: feishuAttentionSuggestionPayload,
      decide: ({ duplicate }) => feishuRuntimeDecision(event, {
        agentId: this.options.queue.agentId,
        duplicate,
        mentioned: feishuMessageMentionsBot(receiveEvent, this.options.config.botOpenId),
      }),
      enrich: async () => {
        let enriched = await this.enrichDirectory(event, receiveEvent);
        enriched = await this.enrichWithQuotedMessage(enriched);
        this.maybeSyncDisplayInfo();
        return enriched;
      },
      itemId: event.id,
      queue: this.options.queue,
      surfaceLog: (input) => input.outcome === 'ignored'
        ? feishuIgnoredLog(this.options.agentRuntimeKind, input.decision.reason)
        : feishuDecisionLog(input.result, this.options.agentRuntimeKind, input.decision),
    });
  }

  private async handleReactionCreated(data: unknown): Promise<void> {
    const reactionEvent = feishuReactionEventFromData(data);
    if (!reactionEvent) return;
    // Only wake on human reactions, not bot-generated ones or unknown operators.
    if (reactionEvent.operator_type !== 'user') return;

    if (!this.client.getMessage) return;

    let message: FeishuConversationMessage | undefined;
    try {
      message = await this.client.getMessage({ messageId: reactionEvent.message_id });
    } catch {
      return;
    }
    if (!message?.chatId) return;

    // Wake when someone reacted to our bot's own message
    if (message.sender?.senderType !== 'app') return;

    const tenantKey = reactionEvent.tenant_key;
    const event = normalizeFeishuReaction({
      appId: this.options.config.appId,
      chatId: message.chatId,
      chatType: message.chatType ?? 'group',
      event: reactionEvent,
      ...(tenantKey ? { tenantKey } : {}),
    });

    const duplicate = Boolean(await this.options.queue.hasSeen(event.id));
    if (duplicate) {
      console.log(JSON.stringify(feishuIgnoredLog(this.options.agentRuntimeKind, 'duplicate_reaction'), null, 2));
      return;
    }

    const decision = await this.options.queue.enqueue(event);
    console.log(JSON.stringify(feishuDecisionLog(decision, this.options.agentRuntimeKind), null, 2));
  }

  private maybeSyncDisplayInfo(): void {
    if (this.displayInfoSyncInFlight) return;
    this.displayInfoSyncInFlight = true;
    void agentFeishuServiceForAgent(this.options.queue.agentId)
      .syncDisplayInfoIfStale({ ttlMs: FEISHU_DISPLAY_INFO_SYNC_TTL_MS })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Feishu display-info sync failed: ${message}`);
      })
      .finally(() => {
        this.displayInfoSyncInFlight = false;
      });
  }

  private async enrichWithQuotedMessage(event: FeishuInboxItem): Promise<FeishuInboxItem> {
    if (!event.parentId) return event;
    if (!this.client.getMessage) return event;
    try {
      const parent = await this.client.getMessage({ messageId: event.parentId });
      if (!parent) return event;
      const quoted = quotedMessageFromConversation(parent);
      if (!quoted) return event;
      return { ...event, quotedMessage: quoted };
    } catch {
      return event;
    }
  }

  private async enrichDirectory(
    event: FeishuInboxItem,
    receiveEvent: FeishuReceiveMessageEvent,
  ): Promise<FeishuInboxItem> {
    const directoryId = feishuDirectoryId({
      appId: this.options.config.appId,
      tenantKey: event.tenantKey,
    });
    if (!directoryId) return event;
    try {
      return await new FeishuDirectoryService({ directoryId }).enrichInboxItem({
        client: this.client,
        item: event,
        receiveEvent,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Feishu directory enrichment failed: ${message}`);
      return event;
    }
  }
}

const FEISHU_DISPLAY_INFO_SYNC_TTL_MS = 6 * 60 * 60 * 1000;

function feishuDecisionLog(
  decision: WakeQueueEnqueueResult,
  agentRuntimeKind: string,
  runtimeDecision?: FeishuRuntimeDecision,
): object {
  return {
    agentRuntime: agentRuntimeKind,
    duplicate: Boolean(decision.duplicate),
    ...(runtimeDecision?.subscription ? { subscription: runtimeDecision.subscription } : {}),
    ingested: !decision.duplicate,
    itemId: decision.item.id,
    platform: 'feishu',
    queued: Boolean(decision.queued),
    reason: runtimeDecision?.reason,
    surface: isFeishuItem(decision.item) ? {
      chatId: decision.item.chatId,
      chatType: decision.item.chatType,
      ...(decision.item.threadId ? { threadId: decision.item.threadId } : {}),
    } : undefined,
  };
}

function feishuIgnoredLog(agentRuntimeKind: string, reason = 'not_addressed_or_unsupported'): object {
  return {
    agentRuntime: agentRuntimeKind,
    ignored: true,
    ingested: false,
    platform: 'feishu',
    reason,
  };
}

function isFeishuItem(item: unknown): item is FeishuInboxItem {
  return Boolean(item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'feishu');
}

function quotedMessageFromConversation(message: FeishuConversationMessage): FeishuQuotedMessage | undefined {
  if (message.deleted) return undefined;
  const content = parseFeishuContent(message.bodyContent);
  let text: string | undefined;
  if (message.messageType === 'text') {
    text = typeof content?.['text'] === 'string' ? content['text'] : undefined;
  } else if (message.messageType === 'post') {
    text = feishuPostPlainTextFromContent(content);
  }
  if (!text?.trim()) return undefined;
  const actorLabel = message.sender?.senderName ?? message.sender?.id ?? 'unknown';
  return { actorLabel, text: text.trim() };
}
