import type { FastifyInstance } from 'fastify';

import { agentSlackServiceForAgent } from '../agents/agent-slack.service.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { defaultSlackFileService } from '../slack/slack-file.service.js';
import { queryParam, untrustedFileHeaders } from './http.js';

export function registerAgentFileRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Params: { agentId: string; fileId: string } }>(
    '/api/agents/:agentId/files/:fileId',
    async (request, reply) => {
      const agent = await defaultAgentRegistryService.serviceFor(request.params.agentId).getConfig();
      const teamId = agent.slack.teamId;
      if (!teamId) return reply.status(404).send({ error: 'file_not_found' });

      const file = await defaultSlackFileService.readCachedFile({ teamId, fileId: request.params.fileId });
      if (!file) return reply.status(404).send({ error: 'file_not_found' });

      reply.header('cache-control', 'private, max-age=300');
      reply.header('content-length', String(file.sizeBytes));
      reply.header('content-type', file.contentType);
      reply.header('content-disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
      reply.headers(untrustedFileHeaders(file.contentType));
      return reply.send(file.bytes);
    },
  );
  fastify.get<{ Params: { agentId: string; fileId: string } }>(
    '/api/agents/:agentId/slack-thumb/:fileId',
    async (request, reply) => {
      const size = queryParam(request.url, 'size') === '720' ? 'thumb_720' : 'thumb_360';
      const { agentId, fileId } = request.params;

      let client;
      try {
        client = await agentSlackServiceForAgent(agentId).getWebClient();
      } catch {
        return reply.status(404).send({ error: 'agent_or_token_not_found' });
      }

      let info;
      try {
        info = (await client.files.info({ file: fileId })).file;
      } catch {
        return reply.status(502).send({ error: 'slack_files_info_failed' });
      }

      const url = size === 'thumb_720'
        ? info?.thumb_720 ?? info?.thumb_360
        : info?.thumb_360 ?? info?.thumb_720;
      if (!url) return reply.status(404).send({ error: 'thumb_unavailable' });

      let upstream;
      try {
        upstream = await agentSlackServiceForAgent(agentId).fetchPrivateUrl(url);
      } catch {
        return reply.status(502).send({ error: 'slack_thumb_fetch_failed' });
      }
      if (!upstream.ok) return reply.status(upstream.status).send({ error: 'slack_thumb_status' });

      const buffer = Buffer.from(await upstream.arrayBuffer());
      reply.header('cache-control', 'private, max-age=300');
      reply.header('content-length', String(buffer.length));
      const contentType = upstream.headers.get('content-type') ?? info?.mimetype ?? 'image/jpeg';
      reply.header('content-type', contentType);
      reply.headers(untrustedFileHeaders(contentType));
      return reply.send(buffer);
    },
  );
}
