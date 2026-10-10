import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LinearInstallRequest } from '../../shared/linear.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { cookieValue, DASHBOARD_AUTH_COOKIE } from '../settings/dashboard-auth.service.js';

const Callback = z.object({ state: z.string().min(1).max(256), code: z.string().min(1).max(4096) });
const bindingFor = (cookie: string | undefined) => createHash('sha256').update(cookie ?? 'local-dashboard').digest('hex');

export function registerAgentLinearRoutes(app: FastifyInstance): void {
  app.get<{ Params: { agentId: string } }>('/api/agents/:agentId/linear', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return new LinearIdentityService(request.params.agentId).status();
  });
  app.post<{ Params: { agentId: string } }>('/api/agents/:agentId/linear/install', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return new LinearIdentityService(request.params.agentId).begin(LinearInstallRequest.parse(request.body),
      bindingFor(cookieValue(request.headers, DASHBOARD_AUTH_COOKIE)));
  });
  app.delete<{ Params: { agentId: string } }>('/api/agents/:agentId/linear', async (request) => {
    await new LinearIdentityService(request.params.agentId).remove();
    return { removed: true };
  });
  app.get('/api/linear/oauth/callback', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const callback = Callback.parse(request.query);
    await LinearIdentityService.finishCallback(callback.state, callback.code,
      bindingFor(cookieValue(request.headers, DASHBOARD_AUTH_COOKIE)));
    return reply.type('text/plain').send('Linear app installed. Close this tab and refresh the agent settings.');
  });
}
