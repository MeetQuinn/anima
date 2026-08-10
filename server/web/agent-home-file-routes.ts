import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, posix, resolve, sep } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { defaultAgentRegistryService } from '../agents/agent.service.js';
import {
  contentTypeFor,
  expandHome,
  INLINE_TEXT_CAP,
} from '../kb/kb.helper.js';
import {
  kbCodeLanguage,
  kbFileExtension,
  kbFileKind,
} from '../../shared/kb-file-types.js';
import type { KbFile } from '../../shared/kb.js';
import { routePath } from './http.js';

type HomeEntry = {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  ext?: string;
  size?: number;
  // File lstat mtime, ISO 8601 UTC. Dirs carry none — the client derives a
  // dir's "latest change inside" from its descendants when they are loaded.
  mtime?: string;
};

// Cap for one directory listing (root or a single expanded folder). Protects
// the dashboard when a home contains a huge node_modules; the client lazy-loads
// each directory so a deep tree no longer has to fit in one response.
export const AGENT_HOME_MANIFEST_ENTRY_CAP = 5_000;

export function registerAgentHomeFileRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { agentId: string };
    Querystring: { dir?: string };
  }>('/api/agents/:agentId/home/files', async (request, reply) => {
    const root = await agentHomeRoot(request.params.agentId).catch(
      () => undefined,
    );
    if (!root) return reply.status(404).send({ error: 'Agent not found' });
    const dir = normalizeDirQuery(request.query.dir);
    if (dir === undefined)
      return reply.status(400).send({ error: 'invalid_dir' });
    return buildDirectoryListing(root, dir);
  });

  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/home/files/*',
    async (request, reply) => {
      const root = await agentHomeRoot(request.params.agentId).catch(
        () => undefined,
      );
      if (!root) return reply.status(404).send({ error: 'Agent not found' });
      const rawPath = routeWildcard(
        request.url,
        `/api/agents/${request.params.agentId}/home/files/`,
      );
      const resolved =
        rawPath === undefined
          ? undefined
          : await resolveHomeFile(root, rawPath);
      if (!resolved) return reply.status(404).send({ error: 'file_not_found' });
      const fileStat = await lstat(resolved.absPath);
      if (!fileStat.isFile())
        return reply.status(400).send({ error: 'not_a_file' });
      return readHomeFile(resolved.relPath, resolved.absPath, fileStat.size);
    },
  );

  fastify.get<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/home/raw/*',
    async (request, reply) => {
      const root = await agentHomeRoot(request.params.agentId).catch(
        () => undefined,
      );
      if (!root) return reply.status(404).send({ error: 'Agent not found' });
      const rawPath = routeWildcard(
        request.url,
        `/api/agents/${request.params.agentId}/home/raw/`,
      );
      const resolved =
        rawPath === undefined
          ? undefined
          : await resolveHomeFile(root, rawPath);
      if (!resolved) return reply.status(404).send({ error: 'file_not_found' });
      const fileStat = await lstat(resolved.absPath);
      if (!fileStat.isFile())
        return reply.status(400).send({ error: 'not_a_file' });

      const body = await readFile(resolved.absPath);
      reply.header('cache-control', 'private, max-age=60');
      reply.header(
        'content-disposition',
        `inline; filename="${encodeURIComponent(posix.basename(resolved.relPath))}"`,
      );
      reply.header('content-length', String(body.length));
      reply.header('content-type', contentTypeFor(resolved.relPath));
      return reply.send(body);
    },
  );
}

async function agentHomeRoot(agentId: string): Promise<string> {
  const agent = await defaultAgentRegistryService
    .serviceFor(agentId)
    .getConfig();
  return resolve(expandHome(agent.homePath));
}

/** Empty string = home root. Rejects absolute, traversal, and empty segments. */
export function normalizeDirQuery(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return '';
  if (raw.includes('\0')) return undefined;
  const normalized = raw
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!normalized) return '';
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    return undefined;
  return parts.join('/');
}

async function buildDirectoryListing(
  root: string,
  dirRelPath: string,
): Promise<{
  root: string;
  dir: string;
  entries: HomeEntry[];
  truncated: boolean;
}> {
  const targetRel = dirRelPath;

  if (targetRel) {
    // Same containment + realpath rules as file reads.
    const resolved = await resolveHomeFile(root, targetRel);
    if (!resolved) {
      return { root, dir: targetRel, entries: [], truncated: false };
    }
    const targetStat = await lstat(resolved.absPath).catch(() => undefined);
    if (!targetStat?.isDirectory()) {
      return { root, dir: targetRel, entries: [], truncated: false };
    }
  } else {
    const rootStat = await stat(root).catch(() => undefined);
    if (!rootStat?.isDirectory()) {
      return { root, dir: '', entries: [], truncated: false };
    }
  }

  const dirAbs = targetRel ? resolve(root, targetRel) : root;
  const dirEntries = await readdir(dirAbs, { withFileTypes: true }).catch(
    () => undefined,
  );
  if (!dirEntries) {
    return { root, dir: targetRel, entries: [], truncated: false };
  }

  const entries: HomeEntry[] = [];

  for (const entry of dirEntries) {
    const relPath = targetRel ? `${targetRel}/${entry.name}` : entry.name;
    const absPath = resolve(root, relPath);
    const entryStat = await lstat(absPath).catch(() => undefined);
    if (!entryStat) continue;

    if (entryStat.isDirectory()) {
      entries.push({ path: relPath, name: entry.name, kind: 'dir' });
      continue;
    }

    if (entryStat.isSymbolicLink()) {
      const targetStat = await stat(absPath).catch(() => undefined);
      if (targetStat?.isDirectory()) {
        // List the link as a dir; do not traverse (same as previous recursive behavior).
        entries.push({ path: relPath, name: entry.name, kind: 'dir' });
        continue;
      }
      if (targetStat?.isFile()) {
        // Symlink to file outside home fails realpath containment on read; still
        // surface as a file entry so the tree matches readdir.
        entries.push(
          fileEntry(relPath, entry.name, entryStat.size, entryStat.mtimeMs),
        );
      }
      continue;
    }

    if (entryStat.isFile()) {
      entries.push(
        fileEntry(relPath, entry.name, entryStat.size, entryStat.mtimeMs),
      );
    }
  }

  // POSIX path order (byte-wise) — same stable sort the recursive manifest used.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const truncated = entries.length > AGENT_HOME_MANIFEST_ENTRY_CAP;
  return {
    root,
    dir: targetRel,
    entries: truncated
      ? entries.slice(0, AGENT_HOME_MANIFEST_ENTRY_CAP)
      : entries,
    truncated,
  };
}

function fileEntry(
  relPath: string,
  name: string,
  size: number,
  mtimeMs?: number,
): HomeEntry {
  const entry: HomeEntry = { path: relPath, name, kind: 'file', size };
  const ext = kbFileExtension(relPath);
  if (ext) entry.ext = ext;
  if (mtimeMs) entry.mtime = new Date(mtimeMs).toISOString();
  return entry;
}

async function resolveHomeFile(
  root: string,
  rawPath: string,
): Promise<{ relPath: string; absPath: string } | undefined> {
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
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep))
    return undefined;

  return {
    relPath: absPath
      .slice(root.length + 1)
      .split(sep)
      .join(posix.sep),
    absPath: realTarget,
  };
}

async function readHomeFile(
  relPath: string,
  absPath: string,
  size: number,
): Promise<Omit<KbFile, 'kbId'>> {
  const kind = kbFileKind(relPath);
  const meta: Omit<KbFile, 'kbId'> = {
    path: relPath,
    name: basename(relPath),
    kind,
    size,
  };
  if (kind === 'code') {
    const language = kbCodeLanguage(relPath);
    if (language) meta.language = language;
  }
  if (
    kind === 'markdown' ||
    kind === 'json' ||
    kind === 'code' ||
    kind === 'text'
  ) {
    if (size > INLINE_TEXT_CAP) {
      meta.truncated = true;
    } else {
      meta.content = await readFile(absPath, 'utf8');
    }
  }
  return meta;
}

function routeWildcard(
  rawUrl: string | undefined,
  prefix: string,
): string | undefined {
  const pathname = routePath(rawUrl);
  if (!pathname.startsWith(prefix)) return undefined;
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return undefined;
  }
}
