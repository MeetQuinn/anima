import type { WebClient } from '@slack/web-api';

import type { AgentConfig } from '../../shared/agent-config.js';
import type { AgentMessageRecord } from '../../shared/messages.js';
import { cliError } from '../cli/cli-errors.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import {
  createFeishuMessageClient,
  type FeishuChatInfo,
  type FeishuMessageClient,
  type FeishuUserBasicInfo,
} from '../feishu/client.js';
import {
  listSubscriptionsForAgent,
  platformForSubscription,
  type SubscriptionRecord,
} from '../inbox/subscription.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import {
  normalizeSlackHandle,
  slackUserHandleCandidates,
} from '../slack/slack.helper.js';
import {
  SlackWorkspaceDirectoryService,
  type SlackConversationInfo,
  type SlackUserInfo,
} from '../slack/workspace-directory.service.js';

const SLACK_USER_ID = /^U[A-Z0-9]+$/;
const SLACK_CONVERSATION_ID = /^[CDG][A-Za-z0-9_-]+$/;
const FEISHU_CHAT_ID = /^oc_[A-Za-z0-9_-]+$/;
const FEISHU_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const SLACK_CONVERSATION_TYPES = 'public_channel,private_channel,mpim';
const DEFAULT_PLACES_LIMIT = 50;
// Matches MessageService's clamp; broad enough to avoid channel dropout while staying bounded.
const PLACES_MESSAGE_WINDOW = 500;

export interface SourcedText {
  source: 'agent_config' | 'platform';
  text: string;
}

export type WhoisResult =
  | {
    handle?: string;
    id: string;
    kind: 'agent' | 'bot' | 'human';
    local: boolean;
    name: string;
    platform: 'slack';
    role?: SourcedText;
  }
  | {
    id: string;
    isMember?: boolean;
    kind: 'channel' | 'dm' | 'mpim';
    memberCount?: number;
    name?: string;
    platform: 'slack';
    topic?: SourcedText;
  }
  | {
    id: string;
    kind: 'agent' | 'user';
    local: boolean;
    name?: string;
    platform: 'feishu';
    role?: SourcedText;
  }
  | {
    id: string;
    kind: 'chat' | 'dm';
    name?: string;
    platform: 'feishu';
  };

export interface PlaceRow {
  handle?: string;
  id: string;
  kind: 'channel' | 'dm';
  label?: string;
  lastDeliveredAt?: string;
  muted: boolean;
  platform: 'slack' | 'feishu';
  topic?: SourcedText;
}

export interface PlacesResult {
  feishuConnected: boolean;
  rows: PlaceRow[];
  slackConnected: boolean;
}

export interface SlackOrientationAdapter {
  getConversationById(id: string): Promise<SlackConversationInfo | undefined>;
  getConversationByName(name: string): Promise<SlackConversationInfo | undefined>;
  getMemberConversations(): Promise<SlackConversationInfo[]>;
  getUserById(id: string): Promise<SlackUserInfo | undefined>;
  getUsersByHandle(handle: string): Promise<SlackUserInfo[]>;
}

export interface FeishuOrientationAdapter {
  getChat(chatId: string): Promise<FeishuChatInfo | undefined>;
  getUser(openId: string): Promise<FeishuUserBasicInfo | undefined>;
}

export interface OrientationDeps {
  feishuAdapterForAgent?(agent: AgentConfig): FeishuOrientationAdapter | undefined;
  getAgentConfig?(agentId: string): Promise<AgentConfig>;
  listAgentConfigs?(): Promise<AgentConfig[]>;
  listMessages?(agentId: string, input: { limit: number }): Promise<AgentMessageRecord[]>;
  listSubscriptions?(agentId: string): Promise<SubscriptionRecord[]>;
  slackAdapterForAgent?(agent: AgentConfig): SlackOrientationAdapter | undefined;
}

export async function whoisForAgent(input: {
  agentId: string;
  deps?: OrientationDeps;
  target: string;
}): Promise<WhoisResult> {
  const deps = input.deps ?? {};
  const [agent, allAgents] = await Promise.all([
    getAgentConfig(deps, input.agentId),
    listAgentConfigs(deps),
  ]);
  const target = input.target.trim();
  if (!target) throw new Error('whois requires a target');

  if (FEISHU_CHAT_ID.test(target)) return whoisFeishuChat(agent, target, deps);
  if (FEISHU_OPEN_ID.test(target)) return whoisFeishuUser(agent, allAgents, target, deps);

  return whoisSlack(agent, allAgents, target, deps);
}

export async function placesForAgent(input: {
  agentId: string;
  deps?: OrientationDeps;
}): Promise<PlacesResult> {
  const deps = input.deps ?? {};
  const [agent, messages, subscriptions] = await Promise.all([
    getAgentConfig(deps, input.agentId),
    listMessages(deps, input.agentId),
    listSubscriptions(deps, input.agentId),
  ]);

  const rows: PlaceRow[] = [
    ...await slackPlaces(agent, messages, subscriptions, deps),
    ...await feishuPlaces(agent, messages, subscriptions, deps),
  ];

  return {
    feishuConnected: Boolean(agent.feishu.connected),
    rows: sortPlaceRows(rows),
    slackConnected: Boolean(agent.slack.connected),
  };
}

export function formatWhois(result: WhoisResult): string {
  if (result.platform === 'slack' && (result.kind === 'agent' || result.kind === 'bot' || result.kind === 'human')) {
    const role = result.kind === 'agent' && result.role ? ` · ${result.role.text}` : '';
    const marker = result.local ? '   (this runtime)' : result.kind === 'bot' ? '   (not managed by this runtime)' : '';
    return compactColumns([
      result.name,
      result.handle ? `@${result.handle.replace(/^@/, '')}` : '',
      result.id,
      `${result.kind}${role}`,
    ]) + marker;
  }
  if (result.platform === 'slack' && (result.kind === 'channel' || result.kind === 'dm' || result.kind === 'mpim')) {
    const name = result.name ? `#${result.name.replace(/^#/, '')}` : result.id;
    const facts = [
      result.kind,
      result.isMember === true ? 'you are a member' : result.isMember === false ? 'not a member' : undefined,
      result.memberCount !== undefined ? `${result.memberCount} members` : undefined,
      result.topic ? `topic="${result.topic.text}"` : undefined,
    ].filter(Boolean).join(' · ');
    return compactColumns([name, result.id, facts]);
  }
  if (result.platform === 'feishu' && (result.kind === 'agent' || result.kind === 'user')) {
    const role = result.kind === 'agent' && result.role ? ` · ${result.role.text}` : '';
    const marker = result.local ? '   (this runtime)' : '';
    return compactColumns([
      result.name ?? result.id,
      result.id,
      `${result.kind}${role}`,
    ]) + marker;
  }
  const label = result.name ?? result.id;
  return compactColumns([label, result.id, result.kind === 'dm' ? 'Feishu DM' : 'Feishu chat']);
}

export function formatPlaces(result: PlacesResult, options: { all?: boolean } = {}): string {
  const lines: string[] = [];
  if (result.slackConnected || result.rows.some((row) => row.platform === 'slack')) {
    lines.push(...formatPlaceSection('Channels', slackRows(result.rows, 'channel', false), options));
    lines.push('');
    lines.push(...formatPlaceSection('DMs', slackRows(result.rows, 'dm', false), options));
    lines.push('');
    lines.push(...formatPlaceSection('Muted', result.rows.filter((row) => row.platform === 'slack' && row.muted), {
      ...options,
      alwaysShow: true,
    }));
  }
  if (result.feishuConnected || result.rows.some((row) => row.platform === 'feishu')) {
    if (lines.length) lines.push('');
    lines.push(...formatPlaceSection('Feishu known chats', feishuRows(result.rows, 'channel', false), options));
    lines.push('');
    lines.push(...formatPlaceSection('Feishu known DMs', feishuRows(result.rows, 'dm', false), options));
    lines.push('');
    lines.push(...formatPlaceSection('Feishu muted', result.rows.filter((row) => row.platform === 'feishu' && row.muted), {
      ...options,
      alwaysShow: true,
    }));
  }
  if (!lines.length) return 'No places found.';
  return lines.join('\n').trimEnd();
}

export function composePlaceRows(input: {
  messages: AgentMessageRecord[];
  seeds: Array<Omit<PlaceRow, 'lastDeliveredAt' | 'muted'> & { muted?: boolean }>;
  subscriptions: SubscriptionRecord[];
}): PlaceRow[] {
  const index = messagesByChannel(input.messages);
  const rows = new Map<string, PlaceRow>();

  for (const seed of input.seeds) {
    const key = placeKey(seed.platform, seed.id);
    rows.set(key, {
      ...seed,
      lastDeliveredAt: index.get(seed.id)?.lastDeliveredAt,
      muted: Boolean(seed.muted),
    });
  }

  for (const subscription of input.subscriptions) {
    if (subscription.kind !== 'channel' || !subscription.mutedAt) continue;
    const platform = platformForSubscription(subscription);
    const key = placeKey(platform, subscription.channelId);
    const existing = rows.get(key);
    rows.set(key, {
      id: subscription.channelId,
      kind: existing?.kind ?? (platform === 'slack' && subscription.channelId.startsWith('D') ? 'dm' : 'channel'),
      label: existing?.label,
      handle: existing?.handle,
      lastDeliveredAt: existing?.lastDeliveredAt ?? index.get(subscription.channelId)?.lastDeliveredAt,
      muted: true,
      platform,
      topic: existing?.topic,
    });
  }

  return sortPlaceRows([...rows.values()]);
}

function getAgentConfig(deps: OrientationDeps, agentId: string): Promise<AgentConfig> {
  return deps.getAgentConfig?.(agentId) ?? defaultAgentRegistryService.serviceFor(agentId).getConfig();
}

function listAgentConfigs(deps: OrientationDeps): Promise<AgentConfig[]> {
  return deps.listAgentConfigs?.() ?? defaultAgentRegistryService.listAgentConfigs();
}

function listMessages(deps: OrientationDeps, agentId: string): Promise<AgentMessageRecord[]> {
  return deps.listMessages?.(agentId, { limit: PLACES_MESSAGE_WINDOW })
    ?? messageServiceForAgent(agentId).list({ limit: PLACES_MESSAGE_WINDOW }).then((page) => page.entries);
}

function listSubscriptions(deps: OrientationDeps, agentId: string): Promise<SubscriptionRecord[]> {
  return deps.listSubscriptions?.(agentId) ?? listSubscriptionsForAgent(agentId);
}

async function whoisSlack(
  agent: AgentConfig,
  allAgents: AgentConfig[],
  target: string,
  deps: OrientationDeps,
): Promise<WhoisResult> {
  const adapter = slackAdapter(agent, deps);
  if (!adapter) throw new Error(`Agent ${agent.id} has no Slack connection configured`);

  if (target.startsWith('#')) {
    const conversation = await adapter.getConversationByName(target.slice(1));
    if (!conversation?.id) throw new Error(`Slack channel not found: ${target}`);
    return slackConversationWhois(conversation);
  }
  if (SLACK_CONVERSATION_ID.test(target)) {
    const conversation = await adapter.getConversationById(target);
    if (!conversation?.id) throw new Error(`Slack channel not found: ${target}`);
    return slackConversationWhois(conversation);
  }
  if (target.startsWith('@')) {
    return slackUserWhois(await uniqueSlackUserForHandle(adapter, target.slice(1)), allAgents);
  }
  if (SLACK_USER_ID.test(target)) {
    const user = await adapter.getUserById(target);
    if (!user?.id) throw new Error(`Slack user not found: ${target}`);
    return slackUserWhois(user, allAgents);
  }

  const userMatches = await adapter.getUsersByHandle(target);
  if (userMatches.length) return slackUserWhois(uniqueSlackUser(userMatches, target), allAgents);
  const conversation = await adapter.getConversationByName(target);
  if (conversation?.id) return slackConversationWhois(conversation);
  throw new Error(`Slack user not found: @${target}`);
}

async function whoisFeishuUser(
  agent: AgentConfig,
  allAgents: AgentConfig[],
  openId: string,
  deps: OrientationDeps,
): Promise<WhoisResult> {
  const adapter = feishuAdapter(agent, deps);
  if (!adapter) throw new Error(`Agent ${agent.id} has no Feishu connection configured`);
  const user = await adapter.getUser(openId);
  const local = allAgents.find((candidate) => candidate.feishu.botOpenId === openId);
  if (local) {
    return {
      id: openId,
      kind: 'agent',
      local: true,
      name: local.profile.displayName || user?.name,
      platform: 'feishu',
      ...(local.profile.role ? { role: { source: 'agent_config', text: local.profile.role } } : {}),
    };
  }
  return {
    id: openId,
    kind: 'user',
    local: false,
    ...(user?.name ? { name: user.name } : {}),
    platform: 'feishu',
  };
}

async function whoisFeishuChat(agent: AgentConfig, chatId: string, deps: OrientationDeps): Promise<WhoisResult> {
  const adapter = feishuAdapter(agent, deps);
  if (!adapter) throw new Error(`Agent ${agent.id} has no Feishu connection configured`);
  const chat = await adapter.getChat(chatId);
  return {
    id: chatId,
    kind: chat?.chatType === 'p2p' ? 'dm' : 'chat',
    ...(chat?.chatName ? { name: chat.chatName } : {}),
    platform: 'feishu',
  };
}

async function slackPlaces(
  agent: AgentConfig,
  messages: AgentMessageRecord[],
  subscriptions: SubscriptionRecord[],
  deps: OrientationDeps,
): Promise<PlaceRow[]> {
  const adapter = slackAdapter(agent, deps);
  const seeds: Array<Omit<PlaceRow, 'lastDeliveredAt' | 'muted'> & { muted?: boolean }> = [];
  if (adapter) {
    const conversations = await adapter.getMemberConversations();
    for (const conversation of conversations) {
      if (!conversation.id) continue;
      seeds.push(slackConversationPlaceSeed(conversation));
    }
  }
  seeds.push(...slackDmSeedsFromMessages(messages));
  return composePlaceRows({ messages, seeds, subscriptions })
    .filter((row) => row.platform === 'slack');
}

async function feishuPlaces(
  agent: AgentConfig,
  messages: AgentMessageRecord[],
  subscriptions: SubscriptionRecord[],
  deps: OrientationDeps,
): Promise<PlaceRow[]> {
  const knownChatIds = new Set<string>();
  for (const message of messages) {
    if (message.platform === 'feishu' && message.channelId && isFeishuChatId(message.channelId)) {
      knownChatIds.add(message.channelId);
    }
  }
  for (const subscription of subscriptions) {
    if (subscription.kind === 'channel' && platformForSubscription(subscription) === 'feishu') {
      knownChatIds.add(subscription.channelId);
    }
  }

  const adapter = feishuAdapter(agent, deps);
  const latestMessages = messagesByChannel(messages);
  const seeds: Array<Omit<PlaceRow, 'lastDeliveredAt' | 'muted'> & { muted?: boolean }> = [];
  const chats = new Map<string, FeishuChatInfo | undefined>();
  if (adapter) {
    await Promise.all([...knownChatIds].map(async (chatId) => {
      chats.set(chatId, await adapter.getChat(chatId));
    }));
  }
  for (const chatId of knownChatIds) {
    const chat = chats.get(chatId);
    const fromMessage = latestMessages.get(chatId)?.latestMessage;
    seeds.push({
      id: chatId,
      kind: (chat?.chatType ?? fromMessage?.channelKind) === 'p2p' ? 'dm' : 'channel',
      label: chat?.chatName ?? fromMessage?.channelDisplayName,
      platform: 'feishu',
    });
  }
  return composePlaceRows({ messages, seeds, subscriptions })
    .filter((row) => row.platform === 'feishu');
}

function slackAdapter(agent: AgentConfig, deps: OrientationDeps): SlackOrientationAdapter | undefined {
  if (!agent.slack.botToken) return undefined;
  if (deps.slackAdapterForAgent) return deps.slackAdapterForAgent(agent);
  return liveSlackOrientationAdapter(agent);
}

function feishuAdapter(agent: AgentConfig, deps: OrientationDeps): FeishuOrientationAdapter | undefined {
  if (!agent.feishu.connected) return undefined;
  if (deps.feishuAdapterForAgent) return deps.feishuAdapterForAgent(agent);
  return liveFeishuOrientationAdapter(createFeishuMessageClient(agent.feishu));
}

function liveSlackOrientationAdapter(agent: AgentConfig): SlackOrientationAdapter {
  let clientPromise: Promise<WebClient> | undefined;
  let directoryPromise: Promise<SlackWorkspaceDirectoryService> | undefined;
  const client = () => {
    clientPromise ??= agentSlackServiceForAgent(agent.id).getWebClient();
    return clientPromise;
  };
  const directory = () => {
    directoryPromise ??= client().then((slackClient) => new SlackWorkspaceDirectoryService({
      client: slackClient,
      teamId: agent.slack.teamId,
    }));
    return directoryPromise;
  };
  return {
    async getConversationById(id) {
      return (await directory()).getConversation(id);
    },
    async getConversationByName(name) {
      return (await directory()).getConversationByName(name, SLACK_CONVERSATION_TYPES).catch((error: unknown) => {
        if (error instanceof Error && error.message.startsWith('Slack channel not found:')) return undefined;
        throw error;
      });
    },
    async getMemberConversations() {
      return (await directory()).getMemberConversations(SLACK_CONVERSATION_TYPES);
    },
    async getUserById(id) {
      return (await directory()).getUser(id);
    },
    async getUsersByHandle(handle) {
      const normalized = normalizeSlackHandle(handle);
      return (await (await directory()).getUsers())
        .filter((user) => !user.deleted && slackUserHandleCandidates(user).includes(normalized));
    },
  };
}

function liveFeishuOrientationAdapter(client: FeishuMessageClient): FeishuOrientationAdapter {
  return {
    async getChat(chatId) {
      return client.getChat?.({ chatId });
    },
    async getUser(openId) {
      return (await client.getUserBasics?.({ openIds: [openId] }))?.[0];
    },
  };
}

async function uniqueSlackUserForHandle(adapter: SlackOrientationAdapter, handle: string): Promise<SlackUserInfo> {
  const matches = await adapter.getUsersByHandle(handle);
  return uniqueSlackUser(matches, handle);
}

function uniqueSlackUser(matches: SlackUserInfo[], handle: string): SlackUserInfo {
  const match = matches[0];
  if (matches.length === 1 && match) return match;
  if (matches.length > 1) {
    throw cliError({
      code: 'anima.ambiguous_user',
      detail: `Candidates: ${matches.map(slackUserCandidateDetail).join('; ')}`,
      hint: 'That handle matches more than one user; use an exact user id, then verify it with anima whois <id>.',
      retryable: false,
    });
  }
  throw new Error(`Slack user not found: @${handle}`);
}

function slackUserWhois(user: SlackUserInfo, agents: AgentConfig[]): WhoisResult {
  const id = user.id ?? '';
  const local = agents.find((agent) => agent.slack.botUserId === id);
  if (local) {
    return {
      handle: local.slack.botHandle ?? user.name,
      id,
      kind: 'agent',
      local: true,
      name: local.profile.displayName || slackDisplayName(user, id),
      platform: 'slack',
      ...(local.profile.role ? { role: { source: 'agent_config', text: local.profile.role } } : {}),
    };
  }
  const isBot = Boolean(user.isBot || user.isAppUser);
  return {
    handle: user.name,
    id,
    kind: isBot ? 'bot' : 'human',
    local: false,
    name: slackDisplayName(user, id),
    platform: 'slack',
  };
}

function slackConversationWhois(conversation: SlackConversationInfo): WhoisResult {
  const kind: Extract<WhoisResult, { platform: 'slack'; kind: 'channel' | 'dm' | 'mpim' }>['kind'] =
    conversation.isIm ? 'dm' : conversation.isMpim ? 'mpim' : 'channel';
  const topic = platformTopic(conversation.topic);
  return {
    id: conversation.id,
    isMember: typeof conversation.isMember === 'boolean' ? conversation.isMember : undefined,
    kind,
    memberCount: typeof conversation.memberCount === 'number' ? conversation.memberCount : undefined,
    name: conversation.name?.trim() || undefined,
    platform: 'slack',
    ...(topic ? { topic } : {}),
  };
}

function slackConversationPlaceSeed(
  conversation: SlackConversationInfo,
): Omit<PlaceRow, 'lastDeliveredAt' | 'muted'> {
  return {
    id: conversation.id,
    kind: conversation.isIm ? 'dm' : 'channel',
    label: conversation.name?.trim() || undefined,
    platform: 'slack',
    ...(platformTopic(conversation.topic) ? { topic: platformTopic(conversation.topic) } : {}),
  };
}

function slackDmSeedsFromMessages(messages: AgentMessageRecord[]): Array<Omit<PlaceRow, 'lastDeliveredAt' | 'muted'>> {
  const byId = new Map<string, Omit<PlaceRow, 'lastDeliveredAt' | 'muted'>>();
  for (const message of messages) {
    if (message.platform && message.platform !== 'slack') continue;
    const id = message.channelId?.trim();
    if (!id?.startsWith('D')) continue;
    const existing = byId.get(id);
    const label = cleanDmLabel(message.dmHandle)
      ?? cleanDmLabel(message.channelDisplayName)
      ?? cleanDmLabel(message.actorHandle)
      ?? cleanDmLabel(message.actorDisplayName)
      ?? cleanDmLabel(message.actor);
    byId.set(id, {
      id,
      kind: 'dm',
      label: existing?.label ?? label,
      handle: existing?.handle ?? cleanDmLabel(message.dmHandle) ?? cleanDmLabel(message.actorHandle),
      platform: 'slack',
    });
  }
  return [...byId.values()];
}

function messagesByChannel(messages: AgentMessageRecord[]): Map<string, {
  lastDeliveredAt?: string;
  latestMessage: AgentMessageRecord;
}> {
  const byChannel = new Map<string, {
    lastDeliveredAt?: string;
    latestMessage: AgentMessageRecord;
  }>();
  for (const message of messages) {
    if (!message.channelId) continue;
    const existing = byChannel.get(message.channelId);
    const next = existing ?? { latestMessage: message };
    if (!existing || message.timestamp > existing.latestMessage.timestamp) next.latestMessage = message;
    if (message.direction === 'in' && (!next.lastDeliveredAt || message.timestamp > next.lastDeliveredAt)) {
      next.lastDeliveredAt = message.timestamp;
    }
    byChannel.set(message.channelId, next);
  }
  return byChannel;
}

function sortPlaceRows(rows: PlaceRow[]): PlaceRow[] {
  return [...rows].sort((a, b) => {
    const byTime = placeSortTime(a).localeCompare(placeSortTime(b));
    if (byTime !== 0) return byTime;
    return placeSortLabel(a).localeCompare(placeSortLabel(b));
  });
}

function placeSortTime(row: PlaceRow): string {
  return row.lastDeliveredAt ?? '';
}

function placeSortLabel(row: PlaceRow): string {
  return `${row.platform}:${row.kind}:${row.label ?? row.handle ?? row.id}`.toLowerCase();
}

function placeKey(platform: string, id: string): string {
  return `${platform}:${id}`;
}

function slackRows(rows: PlaceRow[], kind: PlaceRow['kind'], muted: boolean): PlaceRow[] {
  return rows.filter((row) => row.platform === 'slack' && row.kind === kind && row.muted === muted);
}

function feishuRows(rows: PlaceRow[], kind: PlaceRow['kind'], muted: boolean): PlaceRow[] {
  return rows.filter((row) => row.platform === 'feishu' && row.kind === kind && row.muted === muted);
}

function formatPlaceSection(
  title: string,
  rows: PlaceRow[],
  options: { all?: boolean; alwaysShow?: boolean } = {},
): string[] {
  const visible = options.all ? rows : rows.slice(Math.max(0, rows.length - DEFAULT_PLACES_LIMIT));
  const suffix = rows.length > visible.length
    ? `, showing ${visible.length} most recent; use --all`
    : '';
  const lines = [`${title} (${rows.length}${suffix})`];
  if (!visible.length) {
    if (options.alwaysShow || rows.length === 0) lines.push('  - none');
    return lines;
  }
  lines.push(...visible.map(formatPlaceRow));
  return lines;
}

function formatPlaceRow(row: PlaceRow): string {
  const label = placeDisplayLabel(row);
  const topic = row.topic?.text ?? '';
  const last = row.lastDeliveredAt ? `last_delivery=${row.lastDeliveredAt}` : '(no delivery yet)';
  return `  ${label.padEnd(28)} ${row.id.padEnd(16)} ${topic.padEnd(28)} ${last}`.trimEnd();
}

function placeDisplayLabel(row: PlaceRow): string {
  if (row.platform === 'slack' && row.kind === 'channel') {
    return row.label ? `#${row.label.replace(/^#/, '')}` : row.id;
  }
  if (row.platform === 'slack' && row.kind === 'dm') {
    const label = row.handle ?? row.label;
    return label ? `@${label.replace(/^@/, '')}` : row.id;
  }
  return row.label ?? row.id;
}

function compactColumns(parts: string[]): string {
  return parts.filter((part) => part.trim()).join('   ');
}

function slackDisplayName(user: SlackUserInfo, fallback: string): string {
  return user.displayName?.trim()
    || user.realName?.trim()
    || user.name?.trim()
    || fallback;
}

function slackUserCandidateDetail(user: SlackUserInfo): string {
  const id = user.id ?? 'unknown';
  const handle = user.name ? `@${user.name}` : '@unknown';
  const name = slackDisplayName(user, id);
  return `${name} ${handle} ${id}`;
}

function platformTopic(topic: SlackConversationInfo['topic']): SourcedText | undefined {
  const value = topic?.trim() ?? '';
  return value ? { source: 'platform', text: value } : undefined;
}

function cleanDmLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/^DM with @/i, '')
    .replace(/^DM with /i, '')
    .replace(/^@/, '')
    .trim() || undefined;
}

function isFeishuChatId(value: string): boolean {
  return FEISHU_CHAT_ID.test(value);
}
