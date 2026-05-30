import type { ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { defaultServerSettingsService } from '../settings/settings.service.js';
import { defaultSystemService, SystemServiceError } from '../services/system.service.js';
import { defaultProviderUsageService } from '../provider-usage/provider-usage.service.js';
import {
  defaultRuntimeUpgradeService,
  RuntimeUpgradeConflictError,
  RuntimeUpgradeUnavailableError,
} from '../runtime/runtime-upgrade.js';
import { SidebarOrder } from '../../shared/server-settings.js';
import { HttpError } from './http.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ANIMACTL_SCRIPT = join(PROJECT_ROOT, 'dist/server/cli/animactl.js');

export function registerSystemRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/health', async () => ({ ok: true }));
  fastify.get('/api/provider-availability', async () => defaultSystemService.providerAvailability());
  fastify.get('/api/provider-usage', async () => defaultProviderUsageService.list());
  fastify.get('/api/system-update', async () => defaultRuntimeUpgradeService.status());
  fastify.post('/api/system-update/check', async () => defaultRuntimeUpgradeService.checkNow());
  fastify.get('/api/server-info', async () => defaultSystemService.serverInfo());
  fastify.post('/api/system-update/apply', async (_request, reply) => {
    try {
      const config = await defaultServerSettingsService.readConfig();
      const prepared = await defaultRuntimeUpgradeService.prepareApply({
        animactlScript: ANIMACTL_SCRIPT,
        dashboardHost: config.dashboardHost ?? '127.0.0.1',
        dashboardPort: config.dashboardPort ?? 4174,
        previousStartedAt: defaultSystemService.serverStartedAt(),
      });
      queueAfterResponse(reply.raw, prepared.response.delayMs, prepared.spawn, 'Failed to queue runtime upgrade');
      return reply.status(202).send(prepared.response);
    } catch (error) {
      if (error instanceof RuntimeUpgradeConflictError) throw new HttpError(409, error.message);
      if (error instanceof RuntimeUpgradeUnavailableError) throw new HttpError(503, error.message);
      throw error;
    }
  });
  fastify.post('/api/services/restart', async (_request, reply) => {
    try {
      const prepared = defaultSystemService.prepareServicesRestart();
      queueAfterResponse(reply.raw, prepared.response.delayMs, prepared.spawn, 'Failed to queue services restart');
      return reply.status(202).send(prepared.response);
    } catch (error) {
      if (error instanceof SystemServiceError) throw new HttpError(500, error.message);
      throw error;
    }
  });

  // Sidebar order — global, persisted in ANIMA_HOME/config.json.
  fastify.get('/api/sidebar-order', async () => {
    return { sidebarOrder: await defaultServerSettingsService.getSidebarOrder() };
  });

  fastify.put('/api/sidebar-order', async (request, reply) => {
    const parsed = SidebarOrder.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid sidebar order payload' });
    }
    return { sidebarOrder: await defaultServerSettingsService.setSidebarOrder(parsed.data) };
  });
}

function queueAfterResponse(
  response: ServerResponse,
  delayMs: number,
  task: () => Promise<void>,
  errorPrefix: string,
): void {
  response.once('finish', () => {
    const timer = setTimeout(() => {
      void task().catch((error) => {
        console.error(`${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delayMs);
    timer.unref();
  });
}
