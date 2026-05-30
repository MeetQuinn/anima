import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { errorMessage } from '../ids.js';
import type { RuntimeReleaseTrack, RuntimeUpgradeCheckError } from '../../shared/runtime-upgrade.js';

const execFileAsync = promisify(execFile);
const DEFAULT_NPM_TIMEOUT_MS = 10_000;

export type RuntimeDistTagLookup = (input: {
  packageName: string;
  tag: string;
}) => Promise<string>;

export function npmTagForReleaseTrack(track: RuntimeReleaseTrack): string {
  return track === 'canary' ? 'canary' : 'latest';
}

export async function npmDistTagLookup(input: {
  packageName: string;
  tag: string;
}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('npm', [
      'view',
      `${input.packageName}@${input.tag}`,
      'version',
      '--json',
    ], {
      maxBuffer: 1024 * 1024,
      timeout: DEFAULT_NPM_TIMEOUT_MS,
    });
    const trimmed = stdout.trim();
    if (!trimmed) throw new Error('npm returned an empty version');
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string' && parsed) return parsed;
    throw new Error(`npm returned non-string version: ${trimmed}`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw Object.assign(new Error('Unable to parse npm version response'), { code: 'PARSE' });
    }
    throw error;
  }
}

export function runtimeUpgradeCheckError(error: unknown): RuntimeUpgradeCheckError {
  const message = errorMessage(error);
  const type = typeof error === 'object' && error && 'code' in error && error.code === 'PARSE'
    ? 'parse'
    : message.includes('timed out') || message.includes('ENOTFOUND') || message.includes('ECONN')
      ? 'network'
      : 'unknown';
  return { message: `Unable to check npm dist-tag: ${message}`, type };
}

export function compareRuntimeVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return Math.sign(a[key] - b[key]);
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = a.prerelease[index];
    const rightId = b.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const compared = comparePrereleaseId(leftId, rightId);
    if (compared !== 0) return compared;
  }
  return 0;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`Invalid semver version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrereleaseId(left: string, right: string): number {
  const leftNumber = numericIdentifier(left);
  const rightNumber = numericIdentifier(right);
  if (leftNumber !== undefined && rightNumber !== undefined) return Math.sign(leftNumber - rightNumber);
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return Math.sign(left.localeCompare(right));
}

function numericIdentifier(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  return Number(value);
}
