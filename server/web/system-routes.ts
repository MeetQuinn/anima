import type { ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { defaultServerSettingsService } from '../settings/settings.service.js';
import { defaultSystemService, SystemServiceError } from '../services/system.service.js';
import { defaultProviderUsageService } from '../provider-usage/provider-usage.service.js';
import {
  defaultProviderCliService,
  ProviderCliConflictError,
  ProviderCliUnavailableError,
} from '../provider-cli/provider-cli.service.js';
import {
  defaultRuntimeUpgradeService,
  RuntimeUpgradeConflictError,
  RuntimeUpgradeUnavailableError,
} from '../runtime-management/runtime-upgrade.js';
import { ProviderUsageKind } from '../../shared/provider-usage.js';
import { SidebarOrder, WorkspacePlatform } from '../../shared/server-settings.js';
import { defaultTeamService, TeamServiceError } from '../teams/team.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { HttpError } from './http.js';
import { z } from 'zod';

const TeamCreateRequest = z.object({
  name: z.string().trim().min(1),
  home: z.string().trim().min(1).optional(),
}).strict();

// Edit an existing team. Both fields optional, but at least one must be present.
const TeamUpdateRequest = z
  .object({
    name: z.string().trim().min(1).optional(),
    home: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.home !== undefined, {
    message: 'at least one of name or home must be provided',
  });

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ANIMACTL_SCRIPT = join(PROJECT_ROOT, 'dist/server/cli/animactl.js');

export function registerSystemRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/health', async () => ({ ok: true }));
  fastify.get('/api/provider-availability', async () => defaultSystemService.providerAvailability());
  fastify.get('/api/provider-usage', async () => defaultProviderUsageService.list());
  fastify.get('/api/provider-usage/:provider', async (request, reply) => {
    const parsed = ProviderUsageKind.safeParse((request.params as { provider?: unknown }).provider);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid provider usage provider' });
    return defaultProviderUsageService.get(parsed.data);
  });
  fastify.get('/api/provider-cli-status', async () => defaultProviderCliService.status());
  fastify.post('/api/provider-cli-status/check', async () => defaultProviderCliService.checkNow());
  fastify.post('/api/provider-cli-status/:provider/check', async (request, reply) => {
    const parsed = ProviderUsageKind.safeParse((request.params as { provider?: unknown }).provider);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid provider CLI provider' });
    return defaultProviderCliService.checkNow(parsed.data);
  });
  fastify.post('/api/provider-cli-status/:provider/apply', async (request, reply) => {
    const parsed = ProviderUsageKind.safeParse((request.params as { provider?: unknown }).provider);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid provider CLI provider' });
    try {
      return await defaultProviderCliService.apply(parsed.data);
    } catch (error) {
      if (error instanceof ProviderCliConflictError) throw new HttpError(409, error.message);
      if (error instanceof ProviderCliUnavailableError) throw new HttpError(503, error.message);
      throw error;
    }
  });
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

  // Teams — the effective registry (default team always present + first). Absent config
  // yields exactly [default], so N=1 installs need no migration write.
  fastify.get('/api/teams', async () => {
    const [teams, agents] = await Promise.all([
      defaultTeamService.listTeams(),
      defaultAgentRegistryService.listAgentConfigs(),
    ]);
    // Surface the "repairable warning" half of the degrade contract: any agent whose teamId
    // no longer resolves. The dashboard renders these as a repair cue; the list still degrades
    // that agent into the default team so nothing is ever hidden.
    const warnings = await defaultTeamService.collectAgentTeamWarnings(
      agents.map((agent) => ({ id: agent.id, teamId: agent.teamId })),
    );
    return { teams, warnings };
  });

  fastify.post('/api/teams', async (request, reply) => {
    const parsed = TeamCreateRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid team payload' });
    }
    try {
      const team = await defaultTeamService.createTeam(parsed.data);
      return reply.status(201).send({ team });
    } catch (error) {
      if (error instanceof TeamServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  fastify.patch('/api/teams/:teamId', async (request, reply) => {
    const teamId = (request.params as { teamId?: string }).teamId;
    if (!teamId) return reply.status(400).send({ error: 'Missing team id' });
    const parsed = TeamUpdateRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid team update payload' });
    }
    try {
      const team = await defaultTeamService.updateTeam(teamId, parsed.data);
      return reply.send({ team });
    } catch (error) {
      if (error instanceof TeamServiceError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  // Workspace platform — global default inherited by newly-created agents.
  fastify.get('/api/workspace-platform', async () => {
    return { platform: await defaultServerSettingsService.getWorkspacePlatform() };
  });

  fastify.put('/api/workspace-platform', async (request, reply) => {
    const parsed = WorkspacePlatform.safeParse(
      typeof request.body === 'object' && request.body !== null && 'platform' in request.body
        ? (request.body as { platform?: unknown }).platform
        : request.body,
    );
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid workspace platform payload' });
    }
    return { platform: await defaultServerSettingsService.setWorkspacePlatform(parsed.data) };
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
