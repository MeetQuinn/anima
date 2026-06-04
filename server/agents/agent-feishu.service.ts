import type { AgentConnectFeishuRequest, AgentFeishuRegisterAppRequest } from '../../shared/agent-config.js';
import { registerFeishuApp, type FeishuRegisterAppResult } from '../feishu/client.js';
import { defaultAgentRegistryService } from './agent.service.js';
import { randomUUID } from 'crypto';

type RegisterFeishuApp = typeof registerFeishuApp;

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
  registerFeishuApp?: RegisterFeishuApp;
}

export class AgentFeishuService {
  constructor(private readonly agentId: string, private readonly deps: AgentFeishuServiceDeps = {}) {}

  async connect(input: AgentConnectFeishuRequest) {
    const service = defaultAgentRegistryService.serviceFor(this.agentId);
    const current = await service.getConfig();
    return service.saveConfig({
      ...current,
      feishu: {
        ...current.feishu,
        appId: input.appId,
        appSecret: input.appSecret,
        botOpenId: input.botOpenId || undefined,
        encryptKey: input.encryptKey ?? '',
        verificationToken: input.verificationToken ?? '',
      },
    });
  }

  async startAppRegistration(input: AgentFeishuRegisterAppRequest = {}): Promise<FeishuAppRegistrationStatus> {
    this.abortActiveRegistration();
    const agent = await defaultAgentRegistryService.serviceFor(this.agentId).getConfig();
    const requestedBotName = input.botName?.trim();
    const fallbackBotName = input.botName === undefined
      ? agent.profile.displayName.trim() || 'Anima {user}'
      : 'Anima {user}';
    const botName = requestedBotName || fallbackBotName;
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
        desc: 'An Anima agent that works alongside your team in chat.',
        name: botName,
      },
      onQRCodeReady(info) {
        session.expireIn = info.expireIn;
        session.state = 'waiting';
        session.verificationUrl = info.url;
        markReady();
      },
      onStatusChange(info) {
        if (info.status === 'slow_down' || info.status === 'domain_switched') {
          session.state = info.status;
        }
      },
      signal: abortController.signal,
      source: 'anima-dashboard',
    }).then(async (result) => {
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

  private abortActiveRegistration(): void {
    for (const session of registrationSessions.values()) {
      if (session.agentId !== this.agentId) continue;
      if (session.state === 'connected' || session.state === 'failed') continue;
      session.abortController.abort();
      session.state = 'failed';
      session.error = { code: 'abort', message: 'A newer Feishu app registration was started.' };
    }
  }

  private async completeRegistration(
    session: FeishuAppRegistrationSession,
    result: FeishuRegisterAppResult,
  ): Promise<void> {
    session.agent = await this.connect({
      appId: result.appId,
      appSecret: result.appSecret,
    });
    session.state = 'connected';
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
