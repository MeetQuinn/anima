import type { Server } from 'node:http';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import { registerAgentRoutes } from './agent-routes.js';
import { registerClientErrorRoutes } from './client-error-routes.js';
import { registerDashboardAuthGuard, registerDashboardAuthRoutes } from './dashboard-auth.js';
import { registerErrorHandler } from './http.js';
import { registerReadOnlyGuard } from './read-only.js';
import { registerStaticRoutes } from './static.js';
import { registerSystemRoutes } from './system-routes.js';
import { registerKbRoutes } from './kb-routes.js';

export function buildWebApp(): FastifyInstance {
  const fastify: FastifyInstance = Fastify({ logger: false });

  registerErrorHandler(fastify);
  registerDashboardAuthRoutes(fastify);
  registerDashboardAuthGuard(fastify);
  // AFTER the auth guard, and before every route. Both are `preHandler` hooks and
  // same-type hooks run in registration order, so an unauthenticated governed
  // request still gets `401 authentication_required` and never sees the read-only
  // refusal, which would otherwise leak the governed route inventory to a caller
  // who was never entitled to a reply.
  //
  // This ordering is not a convention: registerReadOnlyGuard throws at boot if the
  // auth guard has not been registered first. Swapping these two lines does not
  // produce a subtly-wrong server, it produces no server.
  //
  // Still ahead of the handler, so the governed handler never runs. And it cannot
  // be a UI state: `curl` reaches the route regardless of what the dashboard draws.
  registerReadOnlyGuard(fastify);
  registerSystemRoutes(fastify);
  registerClientErrorRoutes(fastify);
  registerKbRoutes(fastify);
  registerAgentRoutes(fastify);
  registerStaticRoutes(fastify);

  return fastify;
}

export async function createWebServer(): Promise<Server> {
  const fastify = buildWebApp();
  await fastify.ready();
  return fastify.server;
}
