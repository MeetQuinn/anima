import {
  FEISHU_PROFILE_NAME_SCOPE,
  FEISHU_RECOMMENDED_SCOPE_NAMES,
  FEISHU_RECOMMENDED_SCOPES,
  type AgentConfig,
  type AgentConnectFeishuRequest,
  type AgentFeishuRegisterAppRequest,
  type AgentFeishuRecommendedScopeStatusItem,
  type AgentFeishuScopeAuthUrl,
  type AgentFeishuScopeGrant,
  type AgentFeishuScopeStatus,
} from '../../shared/agent-config.js';
import {
  fetchFeishuBotInfo,
  fetchFeishuAppScopes,
  feishuProfileNameScopeAuthUrl,
  feishuScopeAuthUrl,
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
type GetFeishuAppScopes = (config: AgentConfig['feishu']) => Promise<AgentFeishuScopeGrant[]>;

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
  getFeishuAppScopes?: GetFeishuAppScopes;
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

  async getScopeStatus(): Promise<AgentFeishuScopeStatus> {
    const agent = await defaultAgentRegistryService.serviceFor(this.agentId).getConfig();
    if (!agent.feishu.connected) {
      return {
        connected: false,
        profileName: {
          granted: false,
          scope: FEISHU_PROFILE_NAME_SCOPE,
          state: 'not_connected',
        },
        recommended: {
          granted: false,
          missingScopes: [...FEISHU_RECOMMENDED_SCOPE_NAMES],
          scopes: recommendedScopeStatusItems([]),
          state: 'not_connected',
        },
      };
    }

    try {
      const scopes = await (this.deps.getFeishuAppScopes ?? fetchFeishuAppScopes)(agent.feishu);
      const profileNameScope = scopes.find((scope) => scope.scopeName === FEISHU_PROFILE_NAME_SCOPE);
      const granted = Boolean(profileNameScope?.granted);
      const recommended = recommendedScopeStatus(agent.feishu.appId, scopes);
      return {
        appId: agent.feishu.appId,
        connected: true,
        profileName: {
          ...(granted ? {} : { authUrl: feishuProfileNameScopeAuthUrl(agent.feishu.appId) }),
          granted,
          scope: FEISHU_PROFILE_NAME_SCOPE,
          state: granted ? 'granted' : 'missing',
        },
        recommended,
        scopes,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        appId: agent.feishu.appId,
        connected: true,
        profileName: {
          authUrl: feishuProfileNameScopeAuthUrl(agent.feishu.appId),
          granted: false,
          message,
          scope: FEISHU_PROFILE_NAME_SCOPE,
          state: 'unknown',
        },
        recommended: {
          ...recommendedScopeAuthUrls(agent.feishu.appId, FEISHU_RECOMMENDED_SCOPE_NAMES),
          granted: false,
          message,
          missingScopes: [...FEISHU_RECOMMENDED_SCOPE_NAMES],
          scopes: recommendedScopeStatusItems([]),
          state: 'unknown',
        },
      };
    }
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

function recommendedScopeStatus(
  appId: string,
  grants: readonly AgentFeishuScopeGrant[],
): AgentFeishuScopeStatus['recommended'] {
  const scopes = recommendedScopeStatusItems(grants);
  const missingScopes = scopes.filter((scope) => !scope.granted).map((scope) => scope.scope);
  const granted = missingScopes.length === 0;
  return {
    ...(granted ? {} : recommendedScopeAuthUrls(appId, missingScopes)),
    granted,
    missingScopes,
    scopes,
    state: granted ? 'granted' : 'missing',
  };
}

const RECOMMENDED_SCOPE_AUTH_GROUPS: readonly {
  label: string;
  matches: (scope: string) => boolean;
}[] = [
  {
    label: 'Core chat and teammates',
    matches: (scope) => scope.startsWith('contact:') || scope.startsWith('im:'),
  },
  {
    label: 'Base and whiteboards',
    matches: (scope) => scope.startsWith('bitable:') || scope.startsWith('board:'),
  },
  {
    label: 'Docs',
    matches: (scope) => scope.startsWith('docs:') || scope.startsWith('docx:'),
  },
  {
    label: 'Sheets and Slides',
    matches: (scope) => scope.startsWith('sheets:') || scope.startsWith('slides:'),
  },
  {
    label: 'Drive spaces and Wiki',
    matches: (scope) =>
      scope.startsWith('drive:') || scope.startsWith('space:') || scope.startsWith('wiki:'),
  },
];

function recommendedScopeAuthUrls(
  appId: string,
  missingScopes: readonly string[],
): { authUrl?: string; authUrls?: AgentFeishuScopeAuthUrl[] } {
  const groupedScopes = new Set<string>();
  const authUrls: AgentFeishuScopeAuthUrl[] = [];
  for (const group of RECOMMENDED_SCOPE_AUTH_GROUPS) {
    const scopes = missingScopes.filter((scope) => group.matches(scope));
    if (!scopes.length) continue;
    const authUrl = feishuScopeAuthUrl(appId, scopes);
    if (!authUrl) continue;
    authUrls.push({ authUrl, label: group.label, scopes });
    for (const scope of scopes) groupedScopes.add(scope);
  }
  const otherScopes = missingScopes.filter((scope) => !groupedScopes.has(scope));
  if (otherScopes.length) {
    const authUrl = feishuScopeAuthUrl(appId, otherScopes);
    if (authUrl) authUrls.push({ authUrl, label: 'Other permissions', scopes: otherScopes });
  }
  return {
    ...(authUrls[0]?.authUrl ? { authUrl: authUrls[0].authUrl } : {}),
    ...(authUrls.length ? { authUrls } : {}),
  };
}

function recommendedScopeStatusItems(
  grants: readonly AgentFeishuScopeGrant[],
): AgentFeishuRecommendedScopeStatusItem[] {
  return FEISHU_RECOMMENDED_SCOPES.map((recommended) => {
    const grant = grants.find((scope) => scope.scopeName === recommended.scope);
    return {
      capability: recommended.capability,
      description: recommended.description,
      granted: Boolean(grant?.granted),
      ...(grant?.grantStatus !== undefined ? { grantStatus: grant.grantStatus } : {}),
      label: recommended.label,
      scope: recommended.scope,
    };
  });
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
