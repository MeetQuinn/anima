import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, posix, resolve, sep } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { contentTypeFor, expandHome, INLINE_TEXT_CAP } from '../kb/kb.helper.js';
import { kbCodeLanguage, kbFileExtension, kbFileKind } from '../../shared/kb-file-types.js';
import type { KbFile } from '../../shared/kb.js';
import { routePath } from './http.js';

type HomeEntry = {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  ext?: string;
  size?: number;
};

// Protects the dashboard from a stray node_modules/venv in an agent home.
export const AGENT_HOME_MANIFEST_ENTRY_CAP = 5_000;

export function registerAgentHomeFileRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/home/files',
    async (request, reply) => {
      const root = await agentHomeRoot(request.params.agentId).catch(() => undefined);
      if (!root) return reply.status(404).send({ error: 'Agent not found' });
      return buildManifest(root);
    },
  );

  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/home/files/*',
    async (request, reply) => {
      const root = await agentHomeRoot(request.params.agentId).catch(() => undefined);
      if (!root) return reply.status(404).send({ error: 'Agent not found' });
      const rawPath = routeWildcard(request.url, `/api/agents/${request.params.agentId}/home/files/`);
      const resolved = rawPath === undefined ? undefined : await resolveHomeFile(root, rawPath);
      if (!resolved) return reply.status(404).send({ error: 'file_not_found' });
      const fileStat = await lstat(resolved.absPath);
      if (!fileStat.isFile()) return reply.status(400).send({ error: 'not_a_file' });
      return readHomeFile(resolved.relPath, resolved.absPath, fileStat.size);
    },
  );

  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/home/raw/*',
    async (request, reply) => {
      const root = await agentHomeRoot(request.params.agentId).catch(() => undefined);
      if (!root) return reply.status(404).send({ error: 'Agent not found' });
      const rawPath = routeWildcard(request.url, `/api/agents/${request.params.agentId}/home/raw/`);
      const resolved = rawPath === undefined ? undefined : await resolveHomeFile(root, rawPath);
      if (!resolved) return reply.status(404).send({ error: 'file_not_found' });
      const fileStat = await lstat(resolved.absPath);
      if (!fileStat.isFile()) return reply.status(400).send({ error: 'not_a_file' });

      const body = await readFile(resolved.absPath);
      reply.header('cache-control', 'private, max-age=60');
      reply.header('content-disposition', `inline; filename="${encodeURIComponent(posix.basename(resolved.relPath))}"`);
      reply.header('content-length', String(body.length));
      reply.header('content-type', contentTypeFor(resolved.relPath));
      return reply.send(body);
    },
  );
}

async function agentHomeRoot(agentId: string): Promise<string> {
  const agent = await defaultAgentRegistryService.serviceFor(agentId).getConfig();
  return resolve(expandHome(agent.homePath));
}

async function buildManifest(root: string): Promise<{ root: string; entries: HomeEntry[]; truncated: boolean }> {
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) return { root, entries: [], truncated: false };

  const entries: HomeEntry[] = [];
  const truncated = await collectEntries(root, '', entries);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root, entries, truncated };
}

async function collectEntries(root: string, dirRelPath: string, entries: HomeEntry[]): Promise<boolean> {
  const dirPath = dirRelPath ? resolve(root, dirRelPath) : root;
  const dirEntries = await readdir(dirPath, { withFileTypes: true }).catch(() => undefined);
  if (!dirEntries) return false;

  for (const entry of dirEntries) {
    if (entries.length >= AGENT_HOME_MANIFEST_ENTRY_CAP) return true;
    const relPath = dirRelPath ? `${dirRelPath}/${entry.name}` : entry.name;
    const absPath = resolve(root, relPath);
    const entryStat = await lstat(absPath).catch(() => undefined);
    if (!entryStat) continue;

    if (entryStat.isDirectory()) {
      entries.push({ path: relPath, name: entry.name, kind: 'dir' });
      if (await collectEntries(root, relPath, entries)) return true;
      continue;
    }

    if (entryStat.isSymbolicLink()) {
      const targetStat = await stat(absPath).catch(() => undefined);
      if (targetStat?.isDirectory()) {
        entries.push({ path: relPath, name: entry.name, kind: 'dir' });
        continue;
      }
      entries.push(fileEntry(relPath, entry.name, entryStat.size));
      continue;
    }

    if (entryStat.isFile()) entries.push(fileEntry(relPath, entry.name, entryStat.size));
  }
  return false;
}

function fileEntry(relPath: string, name: string, size: number): HomeEntry {
  const entry: HomeEntry = { path: relPath, name, kind: 'file', size };
  const ext = kbFileExtension(relPath);
  if (ext) entry.ext = ext;
  return entry;
}

async function resolveHomeFile(root: string, rawPath: string): Promise<{ relPath: string; absPath: string } | undefined> {
  if (rawPath.includes('\0')) return undefined;
  const absPath = resolve(root, rawPath);
  if (absPath !== root && !absPath.startsWith(root + sep)) return undefined;

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(absPath);
  } catch {
    return undefined;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return undefined;

  return { relPath: absPath.slice(root.length + 1).split(sep).join(posix.sep), absPath: realTarget };
}

async function readHomeFile(relPath: string, absPath: string, size: number): Promise<Omit<KbFile, 'kbId'>> {
  const kind = kbFileKind(relPath);
  const meta: Omit<KbFile, 'kbId'> = { path: relPath, name: basename(relPath), kind, size };
  if (kind === 'code') {
    const language = kbCodeLanguage(relPath);
    if (language) meta.language = language;
  }
  if (kind === 'markdown' || kind === 'json' || kind === 'code' || kind === 'text') {
    if (size > INLINE_TEXT_CAP) {
      meta.truncated = true;
    } else {
      meta.content = await readFile(absPath, 'utf8');
    }
  }
  return meta;
}

function routeWildcard(rawUrl: string | undefined, prefix: string): string | undefined {
  const pathname = routePath(rawUrl);
  if (!pathname.startsWith(prefix)) return undefined;
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return undefined;
  }
}
