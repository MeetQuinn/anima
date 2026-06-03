import type { FastifyInstance } from 'fastify';

import { redactAgentConfig } from '../agents/agent-config-ops.js';
import { agentFeishuServiceForAgent } from '../agents/agent-feishu.service.js';
import { AgentConnectFeishuRequest } from '../../shared/agent-config.js';

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
}
