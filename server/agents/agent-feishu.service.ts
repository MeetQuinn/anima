import type { AgentConnectFeishuRequest } from '../../shared/agent-config.js';
import { defaultAgentRegistryService } from './agent.service.js';

export class AgentFeishuService {
  constructor(private readonly agentId: string) {}

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
}

export function agentFeishuServiceForAgent(agentId: string): AgentFeishuService {
  return new AgentFeishuService(agentId);
}
