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
  // Before every route: an onRequest hook that closes machine-scoped routes when
  // this runtime is read-only. The handler must never run, so the guard cannot be
  // a late abort inside one — and it cannot be a UI state, because `curl` reaches
  // the route regardless of what the dashboard renders.
  registerReadOnlyGuard(fastify);
  registerDashboardAuthRoutes(fastify);
  registerDashboardAuthGuard(fastify);
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
