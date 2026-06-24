import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { activityServiceForAgent } from '../activities/activity.service.js';
import { redactAgentConfig } from '../agents/agent-config-ops.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { buildAgentDiagnostics } from '../diagnostics/agent-diagnostics.service.js';
import { defaultRuntimeService } from '../runtime/runtime.service.js';
import { messageServiceForAgent } from '../messages/message.service.js';
import { buildAgentChannelList } from './agent-channels.js';
import { reminderServiceForAgent } from '../reminders/reminder.service.js';
import {
  AgentCreateRequest,
  AgentUpdateHomeRequest,
  AgentUpdateProfileRequest,
  AgentUpdateProviderRequest,
} from '../../shared/agent-config.js';
import { registerAgentFeishuRoutes } from './agent-feishu-routes.js';
import { registerAgentFileRoutes } from './agent-file-routes.js';
import { registerAgentSlackRoutes } from './agent-slack-routes.js';
import { HttpError, queryParam } from './http.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

const RotateSessionBody = z.object({ note: z.string().optional() });

export function registerAgentRoutes(fastify: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // Agent config
  // -------------------------------------------------------------------------

  fastify.get('/api/agents', async () =>
    (await defaultAgentRegistryService.listAgentConfigs()).map(redactAgentConfig),
  );
  fastify.get<{ Params: { agentId: string } }>('/api/agents/:agentId', async (request, reply) => {
    const agent = await defaultAgentRegistryService.serviceFor(request.params.agentId).getConfig().catch(() => null);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    return redactAgentConfig(agent);
  });

  fastify.post('/api/agents', async (request) =>
    redactAgentConfig(await defaultAgentRegistryService.createAgent(AgentCreateRequest.parse(request.body))),
  );
  fastify.post<{ Params: { agentId: string } }>('/api/agents/:agentId/home', async (request) => {
    const { homePath } = AgentUpdateHomeRequest.parse(request.body);
    return redactAgentConfig(
      await defaultAgentRegistryService.serviceFor(request.params.agentId).updateHome(homePath),
    );
  });
  fastify.post<{ Params: { agentId: string } }>('/api/agents/:agentId/profile', async (request) =>
    redactAgentConfig(
      await defaultAgentRegistryService
        .serviceFor(request.params.agentId)
        .updateProfile(AgentUpdateProfileRequest.parse(request.body)),
    ),
  );
  fastify.post<{ Params: { agentId: string } }>('/api/agents/:agentId/provider', async (request) =>
    redactAgentConfig(
      await defaultAgentRegistryService
        .serviceFor(request.params.agentId)
        .updateProvider(AgentUpdateProviderRequest.parse(request.body)),
    ),
  );
  fastify.post<{ Params: { agentId: string } }>('/api/agents/:agentId/enable', async (request) =>
    redactAgentConfig(await defaultAgentRegistryService.serviceFor(request.params.agentId).setEnabled(true)),
  );
  fastify.post<{ Params: { agentId: string } }>('/api/agents/:agentId/disable', async (request) => {
    const status = await defaultRuntimeService.getStatus(request.params.agentId);
    if (status.currentItemId) {
      throw new HttpError(409, 'Agent is running. Stop the agent before disabling.');
    }
    return redactAgentConfig(await defaultAgentRegistryService.serviceFor(request.params.agentId).setEnabled(false));
  });
  fastify.delete<{ Params: { agentId: string } }>('/api/agents/:agentId', async (request) =>
    redactAgentConfig(await defaultAgentRegistryService.serviceFor(request.params.agentId).removeAgent()),
  );

  registerAgentSlackRoutes(fastify);
  registerAgentFeishuRoutes(fastify);

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  fastify.get('/api/agent-statuses', async () => defaultRuntimeService.listStatuses());
  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/diagnostics',
    async (request) => buildAgentDiagnostics(request.params.agentId),
  );
  fastify.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/stop',
    async (request, reply) => {
      await defaultRuntimeService.stopCurrentItem(request.params.agentId);
      return reply.status(202).send({ ok: true });
    },
  );
  fastify.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/restart',
    async (request, reply) => {
      const result = await defaultRuntimeService.restartAgent(request.params.agentId);
      return reply.status(202).send({ ok: true, ...result });
    },
  );

  // -------------------------------------------------------------------------
  // Activities
  // -------------------------------------------------------------------------

  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/activities',
    async (request) => {
      const limitParam = queryParam(request.url, 'limit');
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;
      // `before` is an ISO timestamp cursor for backward pagination.
      // Absent on the first (newest) page; present when loading older history.
      const before = queryParam(request.url, 'before') ?? undefined;
      return activityServiceForAgent(request.params.agentId).listActivityFeed({ before, limit });
    },
  );
  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/messages',
    async (request) => {
      const limitParam = queryParam(request.url, 'limit');
      const limit = limitParam ? parseInt(limitParam, 10) : undefined;
      const before = queryParam(request.url, 'before') ?? undefined;
      const since = queryParam(request.url, 'since') ?? undefined;
      const rawDirection = queryParam(request.url, 'direction');
      const direction = rawDirection === 'in' || rawDirection === 'out' ? rawDirection : undefined;
      return messageServiceForAgent(request.params.agentId).list({ before, direction, limit, since });
    },
  );
  // Channels tab: the Slack channels + DMs the agent is a member of. Channel
  // membership is authoritative (`is_member`, includes muted + silent); DMs are
  // folded from message history. See server/web/agent-channels.ts.
  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/subscriptions',
    async (request) => buildAgentChannelList(request.params.agentId),
  );

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/session',
    async (request) => {
      const session = await defaultAgentRegistryService
        .serviceFor(request.params.agentId)
        .getSession();
      if (!session) throw new HttpError(404, 'Session not found');
      return session;
    },
  );
  fastify.post<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/session/rotate',
    async (request) => {
      const { note } = RotateSessionBody.catch({}).parse(request.body);
      return defaultAgentRegistryService
        .serviceFor(request.params.agentId)
        .rotateSession(note?.trim() || undefined);
    },
  );

  // -------------------------------------------------------------------------
  // Reminders
  // -------------------------------------------------------------------------

  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/reminders',
    async (request) => reminderServiceForAgent(request.params.agentId).listAllReminders(),
  );

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------

  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/skills',
    async (request) => defaultAgentRegistryService.serviceFor(request.params.agentId).getSkills(),
  );

  registerAgentFileRoutes(fastify);
}
