import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProviderUsageError, ProviderUsageRow, ProviderUsageWindow } from '../../../shared/provider-usage.js';
import { resolveAnimaHome } from '../../anima-home.js';
import {
  antigravityCommandProblem,
  runAntigravityCommand,
  type AntigravityAgentCheckOptions,
} from '../../providers/antigravity.js';
import { runtimeLaunchPath } from '../../runtime/launch-path.js';
import { available, unavailable, usageError } from '../result.js';
import { numberValue, record, resetAtFromValue, stringValue, windowFromUsedPercent } from './common.js';

type AntigravityUsage = Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>;

/**
 * agy answers `-p /usage` itself, without a turn, from 1.1.11 on. An older agy would
 * send "/usage" to the model as a prompt, so the version is checked first.
 */
const MIN_USAGE_VERSION = [1, 1, 11] as const;
/**
 * `disableSlashCommands: true` in agy's settings makes `-p /usage` a prompt to the
 * model. These settings apply to the check's run only; agy never saves them.
 */
const USAGE_SETTINGS = JSON.stringify({ disableSlashCommands: false });
const USAGE_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 10_000;
const WINDOW_SECONDS: Record<string, number> = { '5h': 5 * 3600, daily: 86_400, weekly: 7 * 86_400 };

/** `timeoutMs` bounds the `/usage` run; `agy --version` always gets 10s. */
export interface AntigravityUsageOptions extends AntigravityAgentCheckOptions {
  command?: string;
  /** Where agy runs and writes its log; `<ANIMA_HOME>/cache/antigravity-usage-probe` by default. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Antigravity's quota as `agy -p /usage --output-format json` reports it. agy answers
 * that read-only command without starting a turn or spending quota, and reads its own
 * sign-in; Anima never touches the credential. The run turns slash commands on for
 * itself, so a machine that turned them off still gets a command, not a prompt. Every
 * run uses one directory and one log file there, which the next run replaces, so
 * checks do not add a log file each to agy's own log directory.
 */
export async function fetchAntigravityUsage(options: AntigravityUsageOptions = {}): Promise<AntigravityUsage> {
  const command = options.command ?? 'agy';
  const dir = options.dir ?? join(resolveAnimaHome(), 'cache', 'antigravity-usage-probe');
  const input = { cwd: dir, env: options.env ?? { ...process.env, PATH: runtimeLaunchPath() } };
  // The Antigravity app's own `agy` opens an editor window for any arguments; never start it.
  const launcher = antigravityCommandProblem(command, input.env);
  if (launcher) return unavailable(usageError('not_configured', launcher));
  try {
    await mkdir(dir, { recursive: true });
    const version = await runAntigravityCommand(command, ['--version'], 'agy --version', input, {
      killGraceMs: options.killGraceMs,
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    const tooOld = versionProblem(version.code === 0 ? version.stdout : '');
    if (tooOld) return unavailable(tooOld);
    const result = await runAntigravityCommand(
      command,
      ['--log-file', join(dir, 'agy.log'), '--settings', USAGE_SETTINGS, '-p', '/usage', '--output-format', 'json'],
      'agy -p /usage',
      input,
      { killGraceMs: options.killGraceMs, timeoutMs: options.timeoutMs ?? USAGE_TIMEOUT_MS },
    );
    // agy also exits 2 for a flag it does not know, so `--settings` on an agy without it.
    // `not_configured`, like an old version, so the card shows the `agy update` hint.
    if (result.code === 2 && result.stderr.includes('provided but not defined')) {
      return unavailable(usageError(
        'not_configured',
        'This Antigravity CLI does not accept `--settings`, which the quota check needs; update it with `agy update`.',
      ));
    }
    // agy exits 2 when the sign-in is an API key, which has no account quota.
    if (result.code === 2) {
      return unavailable(usageError(
        'not_configured',
        'Antigravity is signed in with an API key, which has no account quota. Its usage is in AI Studio.',
      ));
    }
    if (result.code !== 0) {
      const last = result.stderr.trim().split('\n').at(-1)?.trim().slice(0, 200);
      return unavailable(usageError(
        'unknown',
        `\`agy -p /usage\` exited with ${result.signal ?? `code ${String(result.code)}`}${last ? `: ${last}` : ''}`,
      ));
    }
    const parsed = parseAntigravityUsageOutput(result.stdout);
    return parsed.error ? unavailable(parsed.error) : available(parsed.windows);
  } catch (error) {
    const spawnError = error as NodeJS.ErrnoException;
    if (spawnError.code === 'ENOENT' && spawnError.syscall?.startsWith('spawn')) {
      return unavailable(usageError(
        'not_configured',
        'Antigravity CLI not found. Install it so `agy --version` works, then run `agy` once and sign in.',
      ));
    }
    return unavailable(usageError('unknown', error instanceof Error ? error.message : 'Antigravity usage check failed'));
  }
}

/**
 * Why this `agy --version` output rules out `-p /usage`, or undefined when it does not.
 * The card shows the message of any error but `unknown`, so an old agy, which
 * `agy update` fixes, is `not_configured`.
 */
function versionProblem(output: string): ProviderUsageError | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return usageError('unknown', 'Could not read the Antigravity CLI version, so its quota was not checked.');
  const version = match.slice(1, 4).map(Number);
  for (const [index, minimum] of MIN_USAGE_VERSION.entries()) {
    if (version[index]! > minimum) return undefined;
    if (version[index]! < minimum) {
      return usageError(
        'not_configured',
        `Antigravity CLI ${match[0]} cannot report quota; ${MIN_USAGE_VERSION.join('.')} or later can (\`agy update\`).`,
      );
    }
  }
  return undefined;
}

/**
 * Reads the `/usage` answer: groups of models that share limits ("Gemini Models"),
 * each with buckets for a window (`5h`, `weekly`) holding the remaining fraction and
 * the reset time. A bucket that has never been drawn on resets at the epoch, which
 * means no reset is pending. Labels follow the other providers' ("Weekly Fable"):
 * window first, then the group. Within a group, shorter windows come first.
 */
export function parseAntigravityUsageOutput(output: string): { error?: ProviderUsageError; windows: ProviderUsageWindow[] } {
  let root: Record<string, unknown> | undefined;
  try {
    root = record(JSON.parse(output));
  } catch {
    root = undefined;
  }
  const answer = record(root?.command);
  if (!root || stringValue(root.status) !== 'SUCCESS' || stringValue(answer?.name) !== 'usage') {
    return { error: usageError('parse_error', 'Antigravity did not answer /usage with its quota'), windows: [] };
  }
  const groups = record(answer?.data)?.groups;
  const windows: ProviderUsageWindow[] = [];
  for (const rawGroup of Array.isArray(groups) ? groups : []) {
    const group = record(rawGroup);
    const groupLabel = antigravityGroupLabel(stringValue(group?.name));
    const groupWindows: ProviderUsageWindow[] = [];
    for (const rawBucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const bucket = record(rawBucket);
      const remaining = numberValue(bucket?.remaining_fraction);
      if (!bucket || remaining === undefined || bucket.disabled === true) continue;
      const window = stringValue(bucket.window)?.toLowerCase();
      const resetsAt = resetAtFromValue(bucket.reset_time);
      const parsed = windowFromUsedPercent(
        [antigravityWindowLabel(window, stringValue(bucket.name)), groupLabel].filter(Boolean).join(' '),
        100 - remaining * 100,
        {
          ...(resetsAt && Date.parse(resetsAt) > 0 ? { resetsAt } : {}),
          ...(window && WINDOW_SECONDS[window] ? { windowSeconds: WINDOW_SECONDS[window] } : {}),
        },
      );
      if (parsed) groupWindows.push(parsed);
    }
    groupWindows.sort((a, b) => (a.windowSeconds ?? Infinity) - (b.windowSeconds ?? Infinity));
    windows.push(...groupWindows);
  }
  if (windows.length === 0) {
    return { error: usageError('parse_error', 'Antigravity reported no quota windows'), windows: [] };
  }
  return { windows };
}

function antigravityWindowLabel(window: string | undefined, name: string | undefined): string {
  if (window === '5h') return '5h';
  if (window) return `${window[0]!.toUpperCase()}${window.slice(1)}`;
  return name ?? 'Quota';
}

/** "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude/GPT", so labels stay short. */
function antigravityGroupLabel(name: string | undefined): string | undefined {
  return name?.replace(/\s+models$/i, '').replaceAll(' and ', '/').trim() || undefined;
}
