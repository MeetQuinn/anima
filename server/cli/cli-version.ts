import { readFileSync } from 'node:fs';

/**
 * Version of the package this CLI was installed from: the repo root in a
 * checkout, `@meetquinn/animactl` when installed from npm. Both keep the
 * compiled CLI at `dist/server/cli/`.
 */
export function cliPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
