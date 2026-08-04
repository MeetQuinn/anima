import { DateTime } from 'luxon';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { agentTokenUsageReport } from '../usage/agent-token-usage.service.js';
import { HttpError, queryParam } from './http.js';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function registerAgentTokenUsageRoutes(fastify: FastifyInstance): void {
  fastify.get('/api/agent-token-usage', async (request) => {
    const timezone = queryParam(request.url, 'timezone') ?? 'UTC';
    const zoneNow = DateTime.now().setZone(timezone);
    if (!zoneNow.isValid) throw new HttpError(400, 'Invalid timezone');
    const through = IsoDate.parse(queryParam(request.url, 'through') ?? zoneNow.toISODate());
    const defaultFrom = DateTime.fromISO(through, { zone: timezone }).minus({ days: 363 }).toISODate();
    const from = IsoDate.parse(queryParam(request.url, 'from') ?? defaultFrom);
    const start = DateTime.fromISO(from, { zone: timezone });
    const end = DateTime.fromISO(through, { zone: timezone });
    const spanDays = Math.round(end.diff(start, 'days').days);
    if (!start.isValid || !end.isValid || spanDays < 0 || spanDays > 371) {
      throw new HttpError(400, 'Token usage range must be between 1 and 372 days');
    }
    const agentId = queryParam(request.url, 'agentId') ?? undefined;
    try {
      return await agentTokenUsageReport({
        ...(agentId ? { agentId } : {}),
        from,
        through,
        timezone,
      });
    } catch (error) {
      if (agentId && error instanceof Error && error.message === `Agent not found: ${agentId}`) {
        throw new HttpError(404, 'Agent not found');
      }
      throw error;
    }
  });
}
