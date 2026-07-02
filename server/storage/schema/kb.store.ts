// Disk schema for kbs/<kbId>/config.json.
// KB configs store server-local root paths; web/API responses must redact them.

import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { DEFAULT_TEAM_ID } from '../../../shared/server-settings.js';
import { resolveAnimaHome } from '../../anima-home.js';
import { JsonStore } from '../json-store.js';

export const KB_ID = /^[A-Za-z0-9._-]+$/;

export const KbRecord = z.object({
  // URL-safe slug used in /kb/<id>/... routes. This is not a filesystem path.
  id: z.string().regex(KB_ID),
  label: z.string().min(1),
  path: z.string().min(1),
  // Owning team. Always resolved on read (legacy configs without it degrade to
  // the default team) so downstream code never has to backfill again.
  teamId: z.string().min(1),
}).strict();

export type KbRecord = z.infer<typeof KbRecord>;

// On-disk shape. teamId is optional here so pre-team KB configs still parse; it
// is backfilled to the default team when read into a KbRecord (see read/update).
const KbFileConfig = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  teamId: z.string().min(1).optional(),
}).strict();

type KbFileConfig = z.infer<typeof KbFileConfig>;

// Resolve a stored (possibly team-less legacy) config into a full KbRecord.
function toRecord(id: string, cfg: KbFileConfig): KbRecord {
  return {
    id,
    label: cfg.label,
    path: cfg.path,
    teamId: cfg.teamId?.trim() ? cfg.teamId : DEFAULT_TEAM_ID,
  };
}

function getKbConfigFileStore(id: string): JsonStore<KbFileConfig> {
  assertKbId(id);
  return new JsonStore<KbFileConfig>({
    empty: () => ({ label: '', path: '', teamId: DEFAULT_TEAM_ID }),
    parse: KbFileConfig.parse,
    path: () => kbConfigPath(id),
  });
}

function kbConfigPath(id: string): string {
  return join(kbDir(id), 'config.json');
}

function kbConfigExists(id: string): boolean {
  return existsSync(kbConfigPath(id));
}

function kbsDir(): string {
  return join(resolveAnimaHome(), 'kbs');
}

function kbDir(id: string): string {
  return join(kbsDir(), id);
}

export class KbStore {
  private readonly file: JsonStore<KbFileConfig>;

  constructor(private readonly id: string) {
    assertKbId(id);
    this.file = getKbConfigFileStore(id);
  }

  exists(): boolean {
    return kbConfigExists(this.id);
  }

  async read(): Promise<KbRecord> {
    return toRecord(this.id, await this.file.read());
  }

  async write(kb: KbRecord): Promise<KbRecord> {
    if (kb.id !== this.id) throw new Error('kb id is immutable');
    const next = KbRecord.parse(kb);
    await this.file.write({ label: next.label, path: next.path, teamId: next.teamId });
    return next;
  }

  async update(op: (current: KbRecord) => KbRecord): Promise<KbRecord> {
    const next = await this.file.update((current) => {
      const updated = KbRecord.parse(op(toRecord(this.id, current)));
      if (updated.id !== this.id) throw new Error('kb id is immutable');
      return { label: updated.label, path: updated.path, teamId: updated.teamId };
    });
    return toRecord(this.id, next);
  }

  async remove(): Promise<void> {
    await rm(kbDir(this.id), { force: true, recursive: true });
  }
}

export class KbRegistryStore {
  async listIds(): Promise<string[]> {
    if (!existsSync(kbsDir())) return [];
    const entries = await readdir(kbsDir(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && KB_ID.test(entry.name) && kbConfigExists(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  async list(): Promise<KbRecord[]> {
    return Promise.all((await this.listIds()).map((id) => new KbStore(id).read()));
  }
}

function assertKbId(id: string): void {
  if (!KB_ID.test(id)) throw new Error(`bad kb id: ${id}`);
}
