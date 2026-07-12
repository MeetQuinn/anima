import { z } from 'zod';

import type { KbFileKind } from './kb-file-types.js';

export interface KbView {
  id: string;
  label: string;
  // Owning team. Persisted per KB; a legacy KB with no stored team reads as the
  // default team. The sidebar filters KBs to the current working team by this.
  teamId: string;
}

export const KbCreateRequest = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  path: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
});

export type KbCreateRequest = z.infer<typeof KbCreateRequest>;

export const KbRenameRequest = z.object({
  label: z.string().trim().min(1),
});

export type KbRenameRequest = z.infer<typeof KbRenameRequest>;

// Create a new subdirectory under `parent` (an absolute path inside the browse
// root; omit to target the home root). `name` is a single path segment.
export const KbMkdirRequest = z.object({
  parent: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
});

export type KbMkdirRequest = z.infer<typeof KbMkdirRequest>;

export interface KbTreeNode {
  name: string;
  path: string; // repo-relative POSIX
  type: 'dir' | 'file';
  // Last modification, ISO 8601 UTC. Files carry their lstat mtime; dirs carry
  // the max of their descendants (GitHub-style "latest change inside"), so a
  // dir with no dated descendants has none.
  mtime?: string;
  children?: KbTreeNode[];
}

export interface KbTree {
  kb: KbView;
  nodes: KbTreeNode[];
}

export interface KbFile {
  kbId: string;
  path: string; // repo-relative POSIX
  name: string;
  kind: KbFileKind;
  size: number;
  language?: string; // syntax-highlight hint for `code`
  content?: string; // utf8 text for text-ish kinds within the inline cap
  truncated?: boolean; // text exceeded the inline cap — use the raw route instead
}
