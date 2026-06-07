import type { AgentConfig, AgentConnectFeishuRequest, AgentFeishuRegisterAppRequest } from '../../shared/agent-config.js';
import {
  fetchFeishuBotInfo,
  registerFeishuApp,
  type FeishuBotInfo,
  type FeishuRegisterAppResult,
} from '../feishu/client.js';
import { nowIso } from '../ids.js';
import { WakeQueueService } from '../inbox/wake-queue.service.js';
import { singleLine } from '../json.js';
import { defaultAgentRegistryService } from './agent.service.js';
import { randomUUID } from 'crypto';

type RegisterFeishuApp = typeof registerFeishuApp;
type GetFeishuBotInfo = (config: AgentConfig['feishu']) => Promise<FeishuBotInfo>;

export type FeishuAppRegistrationState =
  | 'starting'
  | 'waiting'
  | 'slow_down'
  | 'domain_switched'
  | 'connected'
  | 'failed';

export interface FeishuAppRegistrationStatus {
  agent?: Awaited<ReturnType<AgentFeishuService['connect']>>;
  error?: {
    code?: string;
    description?: string;
    message?: string;
  };
  expireIn?: number;
  registrationId: string;
  state: FeishuAppRegistrationState;
  verificationUrl?: string;
}

interface FeishuAppRegistrationSession extends FeishuAppRegistrationStatus {
  abortController: AbortController;
  agentId: string;
}

const registrationSessions = new Map<string, FeishuAppRegistrationSession>();

interface AgentFeishuServiceDeps {
  getFeishuBotInfo?: GetFeishuBotInfo;
  registerFeishuApp?: RegisterFeishuApp;
}

export class AgentFeishuService {
  constructor(private readonly agentId: string, private readonly deps: AgentFeishuServiceDeps = {}) {}

  async connect(input: AgentConnectFeishuRequest) {
    this.abortActiveRegistration('Manual Feishu credentials were connected instead.');
    const service = defaultAgentRegistryService.serviceFor(this.agentId);
    const current = await service.getConfig();
    const saved = await service.saveConfig({
      ...current,
      feishu: {
        ...current.feishu,
        appId: input.appId,
        appSecret: input.appSecret,
        botOpenId: input.botOpenId || undefined,
        encryptKey: input.encryptKey ?? '',
        ownerGreetingChatId: undefined,
        ownerGreetingDeliveredAt: undefined,
        ownerGreetingMessageId: undefined,
        ownerGreetingPromptedAt: undefined,
        ownerOpenId: undefined,
        ownerTenantBrand: undefined,
        verificationToken: input.verificationToken ?? '',
      },
    });
    // Legacy/API callers may already know the bot open_id. Keep that connect
    // path fast; explicit/profile/background sync can still refresh avatar.
    if (input.botOpenId?.trim()) return saved;
    return this.syncDisplayInfoForAgent(saved).catch(() => saved);
  }

  async syncDisplayInfo(): Promise<AgentConfig> {
    const agent = await defaultAgentRegistryService.serviceFor(this.agentId).getConfig();
    return this.syncDisplayInfoForAgent(agent);
  }

  async syncDisplayInfoIfStale(options: { ttlMs: number }): Promise<{ synced: boolean }> {
    const agent = await defaultAgentRegistryService.serviceFor(this.agentId).getConfig();
    if (!agent.feishu.connected) return { synced: false };
    if (isWithinTtl(agent.feishu.botProfileSyncedAt, options.ttlMs)) return { synced: false };
    await this.syncDisplayInfoForAgent(agent);
    return { synced: true };
  }

  async startAppRegistration(input: AgentFeishuRegisterAppRequest = {}): Promise<FeishuAppRegistrationStatus> {
    this.abortActiveRegistration();
    const agent = await defaultAgentRegistryService.serviceFor(this.agentId).getConfig();
    const requestedBotName = input.botName?.trim();
    const fallbackBotName = input.botName === undefined
      ? agent.profile.displayName.trim() || 'Anima {user}'
      : 'Anima {user}';
    const botName = requestedBotName || fallbackBotName;
    const appDescription = singleLine(agent.profile.role || '')
      || 'An Anima agent that works alongside your team in chat.';
    const registrationId = randomUUID();
    const abortController = new AbortController();
    const session: FeishuAppRegistrationSession = {
      abortController,
      agentId: this.agentId,
      registrationId,
      state: 'starting',
    };
    registrationSessions.set(registrationId, session);

    let markReady = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });

    const register = this.deps.registerFeishuApp ?? registerFeishuApp;
    void register({
      appPreset: {
        desc: appDescription,
        name: botName,
      },
      onQRCodeReady(info) {
        if (abortController.signal.aborted) return;
        session.expireIn = info.expireIn;
        session.state = 'waiting';
        session.verificationUrl = info.url;
        markReady();
      },
      onStatusChange(info) {
        if (abortController.signal.aborted) return;
        if (info.status === 'slow_down' || info.status === 'domain_switched') {
          session.state = info.status;
        }
      },
      signal: abortController.signal,
      source: 'anima-dashboard',
    }).then(async (result) => {
      if (!this.isRegistrationSessionActive(session)) return;
      await this.completeRegistration(session, result);
      markReady();
    })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        session.error = registrationError(error);
        session.state = 'failed';
        markReady();
      });

    await Promise.race([ready, delay(10_000)]);
    return registrationStatus(session);
  }

  async registrationStatus(registrationId: string): Promise<FeishuAppRegistrationStatus> {
    const session = registrationSessions.get(registrationId);
    if (!session || session.agentId !== this.agentId) {
      throw new Error('Feishu app registration was not found');
    }
    return registrationStatus(session);
  }

  private abortActiveRegistration(message = 'A newer Feishu app registration was started.'): void {
    for (const session of registrationSessions.values()) {
      if (session.agentId !== this.agentId) continue;
      if (session.state === 'connected' || session.state === 'failed') continue;
      session.abortController.abort();
      session.state = 'failed';
      session.error = { code: 'abort', message };
    }
  }

  private async completeRegistration(
    session: FeishuAppRegistrationSession,
    result: FeishuRegisterAppResult,
  ): Promise<void> {
    if (!this.isRegistrationSessionActive(session)) return;
    const agent = await this.connectRegisteredApp(session, result);
    if (!agent || !this.isRegistrationSessionActive(session)) return;
    session.agent = agent;
    session.state = 'connected';
  }

  private isRegistrationSessionActive(session: FeishuAppRegistrationSession): boolean {
    return !session.abortController.signal.aborted
      && registrationSessions.get(session.registrationId) === session;
  }

  private async connectRegisteredApp(session: FeishuAppRegistrationSession, result: FeishuRegisterAppResult) {
    const service = defaultAgentRegistryService.serviceFor(this.agentId);
    const current = await service.getConfig();
    if (!this.isRegistrationSessionActive(session)) return undefined;
    const ownerOpenId = result.userOpenId?.trim() || undefined;
    const ownerChanged = ownerOpenId !== current.feishu.ownerOpenId;
    const saved = await service.saveConfig({
      ...current,
      feishu: {
        ...current.feishu,
        appId: result.appId,
        appSecret: result.appSecret,
        ...(ownerChanged ? {
          ownerGreetingChatId: undefined,
          ownerGreetingDeliveredAt: undefined,
          ownerGreetingMessageId: undefined,
          ownerGreetingPromptedAt: undefined,
        } : {}),
        ownerOpenId,
        ownerTenantBrand: result.tenantBrand,
      },
    });
    if (!this.isRegistrationSessionActive(session)) return undefined;
    const synced = await this.syncDisplayInfoForAgent(saved).catch(() => saved);
    if (!this.isRegistrationSessionActive(session)) return undefined;

    const ownerGreetingPromptedAt = await this.ensureOwnerOnboardingPrompt(synced);
    if (!this.isRegistrationSessionActive(session)) return undefined;
    if (!ownerGreetingPromptedAt || synced.feishu.ownerGreetingPromptedAt === ownerGreetingPromptedAt) {
      return synced;
    }
    const latest = await service.getConfig();
    if (!this.isRegistrationSessionActive(session)) return undefined;
    return service.saveConfig({
      ...latest,
      feishu: {
        ...latest.feishu,
        ownerGreetingPromptedAt,
      },
    });
  }

  private async syncDisplayInfoForAgent(agent: AgentConfig): Promise<AgentConfig> {
    if (!agent.feishu.connected) return agent;
    const info = await this.fetchDisplayInfo(agent.feishu);
    const latest = await defaultAgentRegistryService.serviceFor(this.agentId).getConfig();
    return defaultAgentRegistryService.serviceFor(this.agentId).saveConfig({
      ...latest,
      feishu: {
        ...latest.feishu,
        avatarUrl: info.avatarUrl || undefined,
        botProfileSyncedAt: nowIso(),
        ...(info.openId ? { botOpenId: info.openId } : {}),
      },
    });
  }

  private fetchDisplayInfo(config: AgentConfig['feishu']): Promise<FeishuBotInfo> {
    return (this.deps.getFeishuBotInfo ?? fetchFeishuBotInfo)(config);
  }

  private async ensureOwnerOnboardingPrompt(agent: AgentConfig): Promise<string | undefined> {
    const ownerOpenId = agent.feishu.ownerOpenId?.trim();
    if (!ownerOpenId) return undefined;
    if (agent.feishu.ownerGreetingPromptedAt) return agent.feishu.ownerGreetingPromptedAt;

    const now = nowIso();
    await new WakeQueueService(agent.id).enqueue({
      handling: { createdAt: now, queuedAt: now, status: 'queued', updatedAt: now },
      id: `feishu-onboarding:${agent.id}:${ownerOpenId}`,
      kind: 'feishu_onboarding',
      owner: {
        openId: ownerOpenId,
        ...(agent.feishu.ownerTenantBrand ? { tenantBrand: agent.feishu.ownerTenantBrand } : {}),
      },
      receivedAt: now,
      target: {
        platform: 'feishu',
        receiveId: ownerOpenId,
        receiveIdType: 'open_id',
      },
      text: [
        "You've been set up here. Your owner is the person who connected you to Feishu.",
        'Start by reading your MEMORY.md — its Onboarding section walks you through getting set up — then reply here to introduce yourself to your owner.',
      ].join('\n\n'),
    });
    return now;
  }
}

export function agentFeishuServiceForAgent(agentId: string): AgentFeishuService {
  return new AgentFeishuService(agentId);
}

function registrationStatus(session: FeishuAppRegistrationSession): FeishuAppRegistrationStatus {
  return {
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.expireIn !== undefined ? { expireIn: session.expireIn } : {}),
    registrationId: session.registrationId,
    state: session.state,
    ...(session.verificationUrl ? { verificationUrl: session.verificationUrl } : {}),
  };
}

function registrationError(error: unknown): NonNullable<FeishuAppRegistrationStatus['error']> {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }
  const value = error as { code?: unknown; description?: unknown; message?: unknown };
  return {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// True when `iso` is a valid timestamp within `ttlMs` of now. Unset/unparseable
// timestamps and a non-positive ttl are treated as stale so a sync still runs.
function isWithinTtl(iso: string | undefined, ttlMs: number): boolean {
  if (!iso || ttlMs <= 0) return false;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return false;
  return Date.now() - then < ttlMs;
}
