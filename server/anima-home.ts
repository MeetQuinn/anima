import { AsyncLocalStorage } from 'node:async_hooks';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const animaHomeScope = new AsyncLocalStorage<string>();
// A disappearing/appearing local directory must not redirect an existing
// process into another home. Explicit env and async scopes still take priority.
const defaultHomesByCwd = new Map<string, string>();

export function resolveAnimaHome(): string {
  const scopedHome = animaHomeScope.getStore();
  if (scopedHome) return scopedHome;
  const envHome = process.env.ANIMA_HOME?.trim();
  if (envHome) return resolve(envHome);
  const cwd = process.cwd();
  const existing = defaultHomesByCwd.get(cwd);
  if (existing) return existing;
  const local = join(cwd, '.anima');
  const selected = isDirectory(local) ? local : join(homedir(), '.anima');
  defaultHomesByCwd.set(cwd, selected);
  return selected;
}

export function withAnimaHome<T>(dir: string, body: () => Promise<T>): Promise<T> {
  return animaHomeScope.run(resolve(dir), body);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
