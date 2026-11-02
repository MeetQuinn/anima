import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { LinearSetupRequest } from '../../shared/linear-setup.js';
import { LinearInstallRequest } from '../../shared/linear.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearSetupService } from '../linear/setup.service.js';
import { defaultDashboardAuthService, cookieValue, DASHBOARD_AUTH_COOKIE } from '../settings/dashboard-auth.service.js';
import { sendLinearCompletionPage, sendLinearRetryPage } from './linear-completion-page.js';

const Callback = z.object({ state: z.string().min(1).max(256), code: z.string().min(1).max(4096).optional(), error: z.string().min(1).max(256).optional() }).refine((v) => Boolean(v.code) !== Boolean(v.error));
const bindingFor = (cookie: string | undefined) => createHash('sha256').update(cookie ?? 'local-dashboard').digest('hex');

export function registerAgentLinearRoutes(app: FastifyInstance): void {
  app.get('/api/linear/setup', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return new LinearSetupService().read();
  });
  app.put('/api/linear/setup', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return new LinearSetupService().save(LinearSetupRequest.parse(request.body));
  });
  app.get<{ Params: { agentId: string } }>('/api/agents/:agentId/linear', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return new LinearIdentityService(request.params.agentId).status();
  });
  app.post<{ Params: { agentId: string } }>('/api/agents/:agentId/linear/install', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const input = LinearInstallRequest.parse(request.body);
    const setup = await new LinearSetupService().read();
    if (!setup.callbackUrl || input.callbackUrl !== setup.callbackUrl) throw new Error('Set the Anima public URL in Server settings and refresh the connection form.');
    // Origin belongs to the already-authenticated, same-origin POST. Never use a
    // return address from the OAuth query string or a forwarded host header.
    const origin = new URL(request.headers.origin ?? `${request.protocol}://${request.headers.host}`);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid dashboard origin.');
    return new LinearIdentityService(request.params.agentId).begin(input,
      bindingFor(cookieValue(request.headers, DASHBOARD_AUTH_COOKIE)), new URL('/api/linear/oauth/complete', origin).href);
  });
  app.delete<{ Params: { agentId: string } }>('/api/agents/:agentId/linear', async (request) => {
    await new LinearIdentityService(request.params.agentId).remove();
    return { removed: true };
  });
  app.get('/api/linear/oauth/callback', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    const parsed = Callback.safeParse(request.query);
    if (!parsed.success) return sendLinearRetryPage(reply, false);
    const callback = parsed.data;
    let returnUrl: string | undefined;
    try {
      returnUrl = await LinearIdentityService.callbackReturnUrl(callback.state);
    } catch {
      // Unknown, removed or expired state: the public relay names nothing.
      return sendLinearRetryPage(reply, false);
    }
    if (returnUrl) {
      const target = new URL(returnUrl);
      target.searchParams.set('state', callback.state);
      if (callback.code) target.searchParams.set('code', callback.code);
      else target.searchParams.set('error', 'access_denied');
      return reply.redirect(target.href, 303);
    }
    // Pending attempts created before the public callback relay still require
    // their original dashboard cookie. Remove and prepare again if it expired.
    if (!(await defaultDashboardAuthService.isRequestAuthenticated(request.headers))) return reply.code(401).send({ error: 'authentication_required' });
    return finishAndReturn(reply, callback, cookieValue(request.headers, DASHBOARD_AUTH_COOKIE));
  });
  app.get('/api/linear/oauth/complete', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
    const parsed = Callback.safeParse(request.query);
    if (!parsed.success) return sendLinearRetryPage(reply, true);
    return finishAndReturn(reply, parsed.data, cookieValue(request.headers, DASHBOARD_AUTH_COOKIE));
  });
}

async function finishAndReturn(reply: FastifyReply, callback: z.infer<typeof Callback>, cookie: string | undefined) {
  try {
    const { agentId, outcome } = await LinearIdentityService.finishCallback(callback.state, callback.code, bindingFor(cookie));
    return sendLinearCompletionPage(reply, agentId, outcome);
  } catch {
    // Not tied to an attempt in this session: never guess an agent.
    return sendLinearRetryPage(reply, true);
  }
}
