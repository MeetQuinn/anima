import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAnimaReferencePaths, type AnimaReferencePaths } from './anima-reference.js';

const TEMPLATE_FILE = 'runtime-standing-prompt.md';
const DEFAULT_ROLE = 'general-purpose Anima agent';

let cachedTemplate: string | undefined;

export interface AnimaRuntimeProfile {
  displayName: string;
  referencePaths?: AnimaReferencePaths;
  role?: string;
}

export function buildAnimaRuntimeProfile(profile: AnimaRuntimeProfile): string {
  const name = profile.displayName.trim() || 'Anima agent';
  const role = stripTrailingPeriod(profile.role?.trim() || DEFAULT_ROLE);
  return readBundledTemplate()
    .replaceAll('{{name}}', name)
    .replaceAll('{{role}}', role)
    .replaceAll(
      '{{animaReferenceSection}}',
      buildAnimaReferenceSection(profile.referencePaths ?? resolveAnimaReferencePaths()),
    );
}

function buildAnimaReferenceSection(referencePaths: AnimaReferencePaths): string {
  const lines = [
    'For Anima feature how-tos, read `ANIMA_FEATURES.md` in your home before using an unfamiliar `anima` command.',
  ];

  if (referencePaths.docsPath) {
    lines.push(
      `Bundled Anima docs are available at \`${referencePaths.docsPath}\`. Use them for Anima behavior, configuration, architecture, and operator questions before guessing.`,
      'Good starting points: `guide/how-an-agent-works.md`, `guide/working-with-your-agent.md`, `guide/using-the-dashboard.md`, `architecture/overview.md`, and `runtime-providers.md`.',
    );
  } else {
    lines.push(
      'Bundled Anima docs were not found in this runtime; use `anima <command> --help` and ask a teammate when behavior or configuration is unclear.',
    );
  }

  lines.push(
    "Anima's source is public at <https://github.com/MeetQuinn/anima>. When a local checkout isn't available, read it there for behavior, configuration, and architecture.",
  );

  if (referencePaths.sourcePath) {
    lines.push(
      `A local Anima source checkout is available at \`${referencePaths.sourcePath}\`. Treat it as reference unless the user explicitly asks you to modify Anima itself.`,
    );
  }

  lines.push('For exact CLI flags, run `anima <command> --help` before guessing.');

  return lines.join('\n');
}

function readBundledTemplate(): string {
  if (cachedTemplate !== undefined) return cachedTemplate;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Runtime from compiled dist/server/runtime/standing-prompt.js.
    join(moduleDir, '..', '..', '..', 'templates', TEMPLATE_FILE),
    // Direct TS/dev execution from server/runtime/standing-prompt.ts.
    join(moduleDir, '..', '..', 'templates', TEMPLATE_FILE),
  ];
  for (const path of candidates) {
    try {
      cachedTemplate = readFileSync(path, 'utf8');
      return cachedTemplate;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  throw new Error(`Runtime standing prompt template not found: ${TEMPLATE_FILE}`);
}

function stripTrailingPeriod(value: string): string {
  return value.endsWith('.') ? value.slice(0, -1) : value;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
