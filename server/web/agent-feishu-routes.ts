import type { FastifyInstance } from 'fastify';

import { redactAgentConfig } from '../agents/agent-config-ops.js';
import {
  agentFeishuServiceForAgent,
  type FeishuAppRegistrationStatus,
} from '../agents/agent-feishu.service.js';
import { AgentConnectFeishuRequest, AgentFeishuRegisterAppRequest } from '../../shared/agent-config.js';

export function registerAgentFeishuRoutes(fastify: FastifyInstance): void {
  fastify.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/feishu/connect',
    async (request) =>
      redactAgentConfig(
        await agentFeishuServiceForAgent(request.params.agentId).connect(
          AgentConnectFeishuRequest.parse(request.body),
        ),
      ),
  );
  fastify.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/feishu/register-app',
    async (request) =>
      redactFeishuRegistrationStatus(
        await agentFeishuServiceForAgent(request.params.agentId).startAppRegistration(
          AgentFeishuRegisterAppRequest.parse(request.body ?? {}),
        ),
      ),
  );
  fastify.get<{ Params: { agentId: string; registrationId: string } }>(
    '/api/agents/:agentId/feishu/register-app/:registrationId',
    async (request) =>
      redactFeishuRegistrationStatus(
        await agentFeishuServiceForAgent(request.params.agentId).registrationStatus(request.params.registrationId),
      ),
  );
  fastify.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/feishu/sync-avatar',
    async (request) =>
      redactAgentConfig(await agentFeishuServiceForAgent(request.params.agentId).syncDisplayInfo()),
  );
}

function redactFeishuRegistrationStatus(status: FeishuAppRegistrationStatus): FeishuAppRegistrationStatus {
  return {
    ...status,
    ...(status.agent ? { agent: redactAgentConfig(status.agent) } : {}),
  };
}
