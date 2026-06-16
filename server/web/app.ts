import type { Server } from 'node:http';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import { registerAgentRoutes } from './agent-routes.js';
import { registerClientErrorRoutes } from './client-error-routes.js';
import { registerDashboardAuthGuard, registerDashboardAuthRoutes } from './dashboard-auth.js';
import { registerErrorHandler } from './http.js';
import { registerStaticRoutes } from './static.js';
import { registerSystemRoutes } from './system-routes.js';
import { registerKbRoutes } from './kb-routes.js';

export async function createWebServer(): Promise<Server> {
  const fastify: FastifyInstance = Fastify({ logger: false });

  registerErrorHandler(fastify);
  registerDashboardAuthRoutes(fastify);
  registerDashboardAuthGuard(fastify);
  registerSystemRoutes(fastify);
  registerClientErrorRoutes(fastify);
  registerKbRoutes(fastify);
  registerAgentRoutes(fastify);
  registerStaticRoutes(fastify);

  await fastify.ready();
  return fastify.server;
}
