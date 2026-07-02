import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

import type { FastifyInstance } from 'fastify';

import { errorMessage } from '../ids.js';
import { KbError } from '../kb/kb.helper.js';
import { defaultKbRegistryService, type KbRegistryService, type KbService } from '../kb/kb.service.js';
import { HttpError, queryParam, routePath, sendJsonRaw } from './http.js';
import { KbCreateRequest, KbMkdirRequest, KbRenameRequest } from '../../shared/kb.js';

const KB_RAW_PREFIX = '/kb/raw/';
const KB_CSP =
  "default-src 'self' data: blob:; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'";

export function registerKbRoutes(
  fastify: FastifyInstance,
  options: { kbRegistryService?: KbRegistryService } = {},
): void {
  const kbRegistryService = options.kbRegistryService ?? defaultKbRegistryService;

  fastify.get('/api/kbs', async () => ({ kbs: await kbRegistryService.listKbs() }));
  fastify.get<{ Params: { id: string } }>('/api/kbs/:id', async (request) =>
    kbRegistryService.serviceFor(request.params.id).getKb(),
  );
  fastify.get('/api/filesystem/browse', async (request) =>
    kbRegistryService.browseKbDirectories(queryParam(request.url, 'path')),
  );
  fastify.post('/api/filesystem/mkdir', async (request) => {
    const { parent, name } = KbMkdirRequest.parse(request.body);
    return kbRegistryService.createKbDirectory(parent, name);
  });
  fastify.get<{ Params: { id: string } }>('/api/kbs/:id/tree', async (request) =>
    kbRegistryService.serviceFor(request.params.id).buildTree(),
  );
  fastify.get<{ Params: { id: string } }>('/api/kbs/:id/file', async (request) => {
    const filePath = queryParam(request.url, 'path');
    if (!filePath) throw new HttpError(400, 'path is required');
    return kbRegistryService.serviceFor(request.params.id).readFile(filePath);
  });
  fastify.get<{ Params: { id: string } }>('/api/kbs/:id/download', async (request, reply) => {
    const filePath = queryParam(request.url, 'path');
    if (!filePath) throw new HttpError(400, 'path is required');
    reply.hijack();
    try {
      await serveKbRaw(
        reply.raw,
        kbRegistryService.serviceFor(request.params.id),
        filePath,
        { attachment: true },
      );
    } catch (error) {
      if (!reply.raw.headersSent) {
        const statusCode = error instanceof KbError ? error.statusCode : 500;
        sendJsonRaw(reply.raw, statusCode, { error: errorMessage(error) });
      }
    }
  });

  fastify.post('/api/kbs', async (request) => ({
    kbs: await kbRegistryService.addKb(KbCreateRequest.parse(request.body)),
  }));
  fastify.post<{ Params: { id: string } }>(
    '/api/kbs/:id/rename',
    async (request) => {
      await kbRegistryService.serviceFor(request.params.id).rename(KbRenameRequest.parse(request.body));
      return { kbs: await kbRegistryService.listKbs() };
    },
  );
  fastify.delete<{ Params: { id: string } }>(
    '/api/kbs/:id',
    async (request) => {
      await kbRegistryService.serviceFor(request.params.id).remove();
      return { kbs: await kbRegistryService.listKbs() };
    },
  );

  fastify.get('/kb/raw/*', async (request, reply) => {
    reply.hijack();
    try {
      const rawPath = routePath(request.url);
      const { kbService, filePath } = kbRawTarget(kbRegistryService, rawPath.slice(KB_RAW_PREFIX.length));
      await serveKbRaw(reply.raw, kbService, filePath);
    } catch (error) {
      if (!reply.raw.headersSent) {
        const statusCode = error instanceof KbError ? error.statusCode : 500;
        sendJsonRaw(reply.raw, statusCode, { error: errorMessage(error) });
      }
    }
  });
}

async function serveKbRaw(
  response: ServerResponse,
  kbService: KbService,
  filePath: string,
  options: { attachment?: boolean } = {},
): Promise<void> {
  const { absPath, contentType } = await kbService.resolveRawFile(filePath);
  const body = await readFile(absPath);
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-length': String(body.length),
    'content-security-policy': KB_CSP,
    'content-type': contentType,
    ...(options.attachment ? { 'content-disposition': contentDisposition(filePath) } : {}),
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function kbRawTarget(
  kbRegistryService: KbRegistryService,
  encodedRest: string,
): { filePath: string; kbService: KbService } {
  const slash = encodedRest.indexOf('/');
  if (slash <= 0) throw new KbError(400, 'bad_path');
  let id: string;
  let filePath: string;
  try {
    id = decodeURIComponent(encodedRest.slice(0, slash));
    filePath = decodeURIComponent(encodedRest.slice(slash + 1));
  } catch {
    throw new KbError(400, 'bad_path');
  }
  return { filePath, kbService: kbRegistryService.serviceFor(id) };
}

function contentDisposition(filePath: string): string {
  const filename = filePath.split('/').filter(Boolean).pop() ?? 'download';
  const fallback = filename.replace(/["\\\r\n;]/g, '_') || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
