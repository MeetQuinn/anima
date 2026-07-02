import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import ignore, { type Ignore } from 'ignore';

import { DEFAULT_TEAM_KB_ROOT } from '../../shared/agent-home.js';
import { kbCodeLanguage, kbFileKind } from '../../shared/kb-file-types.js';
import type { KbCreateRequest, KbFile, KbRenameRequest, KbTree, KbView } from '../../shared/kb.js';
import { KbRegistryStore, KbStore } from '../storage/schema/kb.store.js';
import {
  buildTree,
  CACHE_TTL_MS,
  contentTypeFor,
  expandHome,
  INLINE_TEXT_CAP,
  KB_ID,
  KbError,
  kbView,
  normalizeRelPath,
  type KbDirectoryBrowse,
  type ResolvedKbRoot,
} from './kb.helper.js';

export class KbRegistryService {
  private kbsCache: { kbs: ResolvedKbRoot[]; loadedAt: number } | undefined;
  private readonly services = new Map<string, KbService>();

  constructor(private readonly registry: KbRegistryStore = new KbRegistryStore()) {}

  // Test hook: the root/visibility caches have a TTL, so a test switching
  // ANIMA_HOME within the TTL window would otherwise see stale roots.
  clearCaches(): void {
    this.kbsCache = undefined;
    this.services.forEach((service) => service.clearCaches());
  }

  async listKbs(): Promise<KbView[]> {
    const kbs = await this.resolvedKbs();
    return kbs.map((kb) => kbView(kb));
  }

  async browseKbDirectories(rawPath: string | undefined): Promise<KbDirectoryBrowse> {
    const home = await realpath(homedir());
    const requested = rawPath?.trim() ? expandHome(rawPath.trim()) : home;
    const requestedRealpath = await realpath(resolve(requested)).catch(() => undefined);
    if (!requestedRealpath) throw new KbError(404, 'path_not_found');
    if (requestedRealpath !== home && !requestedRealpath.startsWith(home + sep)) {
      throw new KbError(400, 'path outside browse root');
    }
    const currentStat = await stat(requestedRealpath).catch(() => undefined);
    if (!currentStat?.isDirectory()) throw new KbError(400, 'path must be an existing directory');
    const entries = await readdir(requestedRealpath, { withFileTypes: true });
    return {
      path: requestedRealpath,
      entries: entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: join(requestedRealpath, entry.name) }))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    };
  }

  // Create a new subdirectory under an existing directory inside the browse
  // root (home). Mirrors browseKbDirectories' sandboxing: parent must resolve
  // to an existing directory within home, and the name is validated to a single
  // path segment (no separators / traversal / dotfiles). Returns the refreshed
  // browse of the parent so the caller can locate the new directory by name.
  async createKbDirectory(
    rawParent: string | undefined,
    rawName: string,
  ): Promise<KbDirectoryBrowse> {
    const home = await realpath(homedir());
    const requested = rawParent?.trim() ? expandHome(rawParent.trim()) : home;
    const parentRealpath = await realpath(resolve(requested)).catch(() => undefined);
    if (!parentRealpath) throw new KbError(404, 'path_not_found');
    if (parentRealpath !== home && !parentRealpath.startsWith(home + sep)) {
      throw new KbError(400, 'path outside browse root');
    }
    const parentStat = await stat(parentRealpath).catch(() => undefined);
    if (!parentStat?.isDirectory()) throw new KbError(400, 'path must be an existing directory');

    const name = rawName.trim();
    if (!name) throw new KbError(400, 'folder name is required');
    if (
      name === '.' ||
      name === '..' ||
      name.startsWith('.') ||
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.length > 255
    ) {
      throw new KbError(400, 'invalid folder name');
    }

    const target = join(parentRealpath, name);
    // Defense in depth: the joined target must stay directly under the parent.
    if (!target.startsWith(parentRealpath + sep)) {
      throw new KbError(400, 'invalid folder name');
    }
    if (await stat(target).catch(() => undefined)) {
      throw new KbError(409, 'a folder with that name already exists');
    }

    await mkdir(target);
    return this.browseKbDirectories(parentRealpath);
  }

  async addKb(input: KbCreateRequest): Promise<KbView[]> {
    const id = input.id;
    const label = input.label;
    const rootPath = expandHome(input.path);
    if (!KB_ID.test(id)) throw new KbError(400, 'id must be a URL-safe slug');
    const absolutePath = resolve(rootPath);
    const rootStat = await stat(absolutePath).catch(() => undefined);
    if (!rootStat?.isDirectory()) throw new KbError(400, 'path must be an existing directory');
    const store = new KbStore(id);
    if (store.exists()) {
      throw new KbError(409, `kb already exists: ${id}`);
    }
    await store.write({ id, label, path: absolutePath });
    this.clearCaches();
    return this.listKbs();
  }

  async ensureDefaultTeamKbForAgentHome(homePath: string): Promise<void> {
    const teamRoot = resolve(expandHome(DEFAULT_TEAM_KB_ROOT));
    const resolvedHome = resolve(expandHome(homePath));
    if (!isPathInside(resolvedHome, teamRoot)) return;

    const configured = await this.registry.list();
    if (configured.some((kb) => resolve(expandHome(kb.path)) === teamRoot)) return;

    await this.addKb({
      id: nextKbId(configured.map((kb) => kb.id), 'team'),
      label: 'Team',
      path: teamRoot,
    });
  }

  serviceFor(id: string): KbService {
    if (!KB_ID.test(id)) throw new KbError(400, 'bad kb id');
    if (!this.services.has(id)) {
      this.services.set(id, new KbService(id, new KbStore(id), () => this.clearCaches()));
    }
    return this.services.get(id) as KbService;
  }

  private async resolvedKbs(): Promise<ResolvedKbRoot[]> {
    const now = Date.now();
    if (this.kbsCache && now - this.kbsCache.loadedAt < CACHE_TTL_MS) {
      return this.kbsCache.kbs;
    }
    // Let config-validation errors propagate. Swallowing them here would turn
    // malformed KB config into a silent empty surface, hiding the exact config
    // boundary we want explicit.
    const configured = await this.registry.list();
    const kbs: ResolvedKbRoot[] = [];
    for (const entry of configured) {
      const path = resolve(entry.path);
      const kbStat = await stat(path).catch(() => undefined);
      if (kbStat?.isDirectory()) {
        kbs.push({ id: entry.id, label: entry.label, path });
      } else {
        console.error(`kb "${entry.id}" path is not an existing directory, skipping: ${path}`);
      }
    }
    this.kbsCache = { kbs, loadedAt: now };
    return kbs;
  }
}

// Read-only web view over one Knowledge Base directory. If the KB root has
// a root `.gitignore`, those patterns are the exposure filter; otherwise every
// file under the root is visible. `.git/` is VCS metadata, not content, and is
// always skipped. Every request resolves to a root-relative POSIX path that must
// be an exact member of the visible file set before any byte is read.
export class KbService {
  private visibleFilesCache: { files: Set<string>; loadedAt: number } | undefined;

  constructor(
    private readonly id: string,
    private readonly store: KbStore = new KbStore(id),
    private readonly onMutation: () => void = () => {},
  ) {}

  clearCaches(): void {
    this.visibleFilesCache = undefined;
  }

  async getKb(): Promise<KbView> {
    const kb = await this.resolvedKb();
    return kbView(kb);
  }

  async rename(input: KbRenameRequest): Promise<KbView> {
    if (!this.store.exists()) throw new KbError(404, `kb not found: ${this.id}`);
    await this.store.update((kb) => ({ ...kb, label: input.label }));
    this.onMutation();
    return this.getKb();
  }

  async remove(): Promise<void> {
    if (!this.store.exists()) throw new KbError(404, `kb not found: ${this.id}`);
    await this.store.remove();
    this.onMutation();
  }

  async buildTree(): Promise<KbTree> {
    const kb = await this.resolvedKb();
    const files = await this.visibleKbFiles(kb);
    return { kb: kbView(kb), nodes: buildTree([...files]) };
  }

  async readFile(rawPath: string): Promise<KbFile> {
    const { kb, relPath, absPath } = await this.resolveTrackedPath(rawPath);
    const name = posix.basename(relPath);
    const kind = kbFileKind(relPath);
    const fileStat = await lstat(absPath);
    const meta: KbFile = { kbId: kb.id, path: relPath, name, kind, size: fileStat.size };
    if (kind === 'code') {
      const language = kbCodeLanguage(relPath);
      if (language) meta.language = language;
    }
    // Image / HTML / binary render via the raw route (img src / iframe src), so
    // we don't inline their bytes here. Text-ish kinds carry their content for
    // the client renderer, capped.
    if (kind === 'markdown' || kind === 'json' || kind === 'code' || kind === 'text') {
      if (fileStat.size > INLINE_TEXT_CAP) {
        meta.truncated = true;
      } else {
        meta.content = await readFile(absPath, 'utf8');
      }
    }
    return meta;
  }

  async resolveRawFile(rawPath: string): Promise<{ absPath: string; contentType: string }> {
    const { relPath, absPath } = await this.resolveTrackedPath(rawPath);
    return { absPath, contentType: contentTypeFor(relPath) };
  }

  private async resolvedKb(): Promise<ResolvedKbRoot> {
    if (!KB_ID.test(this.id)) throw new KbError(400, 'bad kb id');
    if (!this.store.exists()) throw new KbError(404, 'kb_not_found');
    const entry = await this.store.read();
    const path = resolve(entry.path);
    const kbStat = await stat(path).catch(() => undefined);
    if (!kbStat?.isDirectory()) {
      console.error(`kb "${entry.id}" path is not an existing directory, skipping: ${path}`);
      throw new KbError(404, 'kb_not_found');
    }
    return { id: entry.id, label: entry.label, path };
  }

  private async resolveTrackedPath(rawPath: string): Promise<{ kb: ResolvedKbRoot; relPath: string; absPath: string }> {
    const kb = await this.resolvedKb();
    const relPath = normalizeRelPath(rawPath);
    const files = await this.visibleKbFiles(kb);
    return this.resolveVisibleKbPath(kb, relPath, files);
  }

  private async resolveVisibleKbPath(
    kb: ResolvedKbRoot,
    relPath: string,
    files: Set<string>,
  ): Promise<{ kb: ResolvedKbRoot; relPath: string; absPath: string }> {
    if (!files.has(relPath)) {
      throw new KbError(404, 'not_found');
    }
    let absPath = join(kb.path, relPath);
    // Defensive lexical containment assert (normalizeRelPath already strips `..`).
    const kbResolved = resolve(kb.path);
    const absResolved = resolve(absPath);
    if (absResolved !== kbResolved && !absResolved.startsWith(kbResolved + sep)) {
      throw new KbError(404, 'not_found');
    }
    let fileStat = await lstat(absPath);
    if (fileStat.isSymbolicLink()) {
      const resolvedTarget = await realpath(absPath).catch(() => undefined);
      if (!resolvedTarget) throw new KbError(404, 'not_found');
      const kbRealpath = await realpath(kb.path);
      if (resolvedTarget !== kbRealpath && !resolvedTarget.startsWith(kbRealpath + sep)) {
        throw new KbError(404, 'not_found');
      }
      const targetRelPath = relative(kbRealpath, resolvedTarget).split(sep).join(posix.sep);
      if (!files.has(targetRelPath)) {
        throw new KbError(404, 'not_found');
      }
      absPath = resolvedTarget;
      fileStat = await lstat(absPath);
    }
    if (!fileStat.isFile()) {
      throw new KbError(404, 'not_found');
    }
    return { kb, relPath, absPath };
  }

  private async visibleKbFiles(kb: ResolvedKbRoot): Promise<Set<string>> {
    const now = Date.now();
    if (this.visibleFilesCache && now - this.visibleFilesCache.loadedAt < CACHE_TTL_MS) {
      return this.visibleFilesCache.files;
    }
    const files = new Set<string>();
    const filter = await this.rootGitignoreFilter(kb.path);
    await this.collectVisibleFiles(kb.path, '', filter, files);
    this.visibleFilesCache = { files, loadedAt: now };
    return files;
  }

  private async rootGitignoreFilter(rootPath: string): Promise<Ignore | undefined> {
    // Product v1 uses the KB root `.gitignore` as the boundary. Nested
    // `.gitignore` files are intentionally not loaded yet; add them here if a
    // KB starts relying on subdir-specific ignore rules.
    const content = await readFile(join(rootPath, '.gitignore'), 'utf8').catch(() => undefined);
    return content === undefined ? undefined : ignore().add(content);
  }

  private async collectVisibleFiles(
    rootPath: string,
    dirRelPath: string,
    filter: Ignore | undefined,
    files: Set<string>,
  ): Promise<void> {
    const dirPath = dirRelPath ? join(rootPath, dirRelPath) : rootPath;
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = dirRelPath ? `${dirRelPath}/${entry.name}` : entry.name;
      if (relPath === '.git' || relPath.startsWith('.git/')) continue;
      if (entry.isDirectory()) {
        if (filter?.ignores(`${relPath}/`)) continue;
        await this.collectVisibleFiles(rootPath, relPath, filter, files);
        continue;
      }
      if ((entry.isFile() || entry.isSymbolicLink()) && !filter?.ignores(relPath)) {
        files.add(relPath);
      }
    }
  }
}

export const defaultKbRegistryService = new KbRegistryService();

function nextKbId(existingIds: string[], preferred: string): string {
  const existing = new Set(existingIds);
  if (!existing.has(preferred)) return preferred;
  for (let index = 2; ; index += 1) {
    const candidate = `${preferred}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function isPathInside(path: string, parent: string): boolean {
  const relPath = relative(parent, path);
  return relPath === '' || Boolean(relPath && !relPath.startsWith('..') && !isAbsolute(relPath));
}
