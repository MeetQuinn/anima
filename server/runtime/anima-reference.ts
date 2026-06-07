import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AnimaReferencePaths {
  docsPath?: string;
  sourcePath?: string;
}

let cachedReferencePaths: AnimaReferencePaths | undefined;

export function resolveAnimaReferencePaths(): AnimaReferencePaths {
  if (cachedReferencePaths) return cachedReferencePaths;
  cachedReferencePaths = resolveAnimaReferencePathsFromRoots(packageRootCandidates());
  return cachedReferencePaths;
}

export function resolveAnimaReferencePathsFromRoots(roots: string[]): AnimaReferencePaths {
  const normalizedRoots = uniquePaths(roots.map((root) => resolve(root)));
  const docsPath = normalizedRoots.map((root) => join(root, 'docs')).find(isAnimaDocsDir);
  const sourcePath = normalizedRoots.find(isAnimaSourceRoot);
  const referencePaths: AnimaReferencePaths = {};
  if (docsPath) referencePaths.docsPath = docsPath;
  if (sourcePath) referencePaths.sourcePath = sourcePath;
  return referencePaths;
}

function packageRootCandidates(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return [
    // Runtime from compiled dist/server/runtime/anima-reference.js.
    join(moduleDir, '..', '..', '..'),
    // Direct TS/dev execution from server/runtime/anima-reference.ts.
    join(moduleDir, '..', '..'),
  ];
}

function isAnimaDocsDir(path: string): boolean {
  return (
    existsSync(join(path, 'guide', 'agent-features.md')) &&
    existsSync(join(path, 'guide', 'how-an-agent-works.md')) &&
    existsSync(join(path, 'guide', 'working-with-your-agent.md')) &&
    existsSync(join(path, 'guide', 'using-the-dashboard.md')) &&
    existsSync(join(path, 'architecture', 'overview.md')) &&
    existsSync(join(path, 'runtime-providers.md'))
  );
}

function isAnimaSourceRoot(path: string): boolean {
  return (
    existsSync(join(path, '.git')) &&
    existsSync(join(path, 'server')) &&
    existsSync(join(path, 'web')) &&
    existsSync(join(path, 'shared')) &&
    packageName(path) === '@meetquinn/anima'
  );
}

function packageName(path: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof pkg.name === 'string' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}
