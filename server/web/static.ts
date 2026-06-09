import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { errorMessage } from '../ids.js';
import { dashboardStaticRedirectLocation, isPublicStaticAssetPath } from './dashboard-auth.js';
import { routePath, sendJsonRaw } from './http.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_DIST_DIR = join(PROJECT_ROOT, 'dist/web');

export function registerStaticRoutes(fastify: FastifyInstance): void {
  fastify.setNotFoundHandler(async (request, reply) => {
    if (request.method !== 'GET') {
      return reply.status(404).send({ error: 'not_found' });
    }
    if (routePath(request.url).startsWith('/api/')) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const path = routePath(request.url);
    if (isPublicStaticAssetPath(path)) {
      reply.hijack();
      try {
        const served = await serveStatic(reply.raw, path, { fallbackToIndex: false });
        if (!served) sendJsonRaw(reply.raw, 404, { error: 'not_found' });
      } catch (error) {
        if (!reply.raw.headersSent) sendJsonRaw(reply.raw, 500, { error: errorMessage(error) });
      }
      return;
    }
    const redirectLocation = await dashboardStaticRedirectLocation(request.url, request.headers);
    if (redirectLocation) {
      return reply.redirect(redirectLocation, 302);
    }
    reply.hijack();
    try {
      const served = await serveStatic(reply.raw, path, { fallbackToIndex: true });
      if (!served) sendJsonRaw(reply.raw, 404, { error: 'not_found' });
    } catch (error) {
      if (!reply.raw.headersSent) sendJsonRaw(reply.raw, 500, { error: errorMessage(error) });
    }
  });
}

async function serveStatic(
  response: ServerResponse,
  urlPath: string,
  options: { fallbackToIndex: boolean },
): Promise<boolean> {
  const requested = urlPath.replace(/^\/+/, '') || 'index.html';
  const filePath = resolve(UI_DIST_DIR, requested);
  if (filePath !== UI_DIST_DIR && !filePath.startsWith(UI_DIST_DIR + sep)) {
    return false;
  }

  if (existsSync(filePath)) {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': mimeType(filePath),
    });
    response.end(content);
    return true;
  }

  if (!options.fallbackToIndex) return false;

  const indexPath = join(UI_DIST_DIR, 'index.html');
  if (existsSync(indexPath)) {
    const content = await readFile(indexPath);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(content);
    return true;
  }

  return false;
}

function mimeType(path: string): string {
  const ext = Object.keys(MIME_TYPES).find((e) => path.endsWith(e));
  return MIME_TYPES[ext || ''] || 'application/octet-stream';
}
