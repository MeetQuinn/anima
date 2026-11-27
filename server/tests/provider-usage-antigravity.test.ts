import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fetchAntigravityUsage,
  parseAntigravityUsageOutput,
} from '../provider-usage/providers/antigravity.js';

/** The shape `agy -p /usage --output-format json` printed on agy 1.5.18 (values changed). */
function usageAnswer(groups: unknown[] = defaultGroups()): Record<string, unknown> {
  return {
    command: { data: { description: 'Within each group, models share a weekly limit and a 5-hour limit.', groups }, name: 'usage' },
    conversation_id: 'c0ffee00-0000-4000-8000-000000000000',
    duration_seconds: 0,
    num_turns: 0,
    response: 'Gemini Models ...',
    status: 'SUCCESS',
    usage: { cache_read_tokens: 0, input_tokens: 0, output_tokens: 0, thinking_tokens: 0, total_tokens: 0 },
  };
}

function defaultGroups(): unknown[] {
  return [
    {
      buckets: [
        {
          id: 'gemini-weekly',
          name: 'Weekly Limit Remaining',
          remaining_fraction: 0.9813944697380066,
          reset_time: '2026-12-03T16:44:51Z',
          window: 'weekly',
        },
        {
          id: 'gemini-5h',
          name: 'Five Hour Limit Remaining',
          remaining_fraction: 0.25,
          reset_time: '2026-11-27T07:44:51Z',
          window: '5h',
        },
      ],
      description: 'Models within this group: Gemini 4 Neon, Gemini 3.8 Flash',
      name: 'Gemini Models',
    },
    {
      buckets: [
        { id: '3p-weekly', name: 'Weekly Limit Remaining', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', window: 'weekly' },
        { id: '3p-5h', name: 'Five Hour Limit Remaining', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z', window: '5h' },
      ],
      description: 'Models within this group: Claude Opus 5.5, GPT-OSS 120B',
      name: 'Claude and GPT models',
    },
  ];
}

test('Antigravity usage parser lists each group\'s windows, shortest first, without the epoch reset', () => {
  const parsed = parseAntigravityUsageOutput(JSON.stringify(usageAnswer()));
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.windows, [
    { label: '5h Gemini', remainingPercent: 25, resetsAt: '2026-11-27T07:44:51.000Z', usedPercent: 75, windowSeconds: 18_000 },
    { label: 'Weekly Gemini', remainingPercent: 98, resetsAt: '2026-12-03T16:44:51.000Z', usedPercent: 2, windowSeconds: 604_800 },
    // Never drawn on: full, and the epoch reset time means none is pending.
    { label: '5h Claude/GPT', remainingPercent: 100, usedPercent: 0, windowSeconds: 18_000 },
    { label: 'Weekly Claude/GPT', remainingPercent: 100, usedPercent: 0, windowSeconds: 604_800 },
  ]);
});

test('Antigravity usage parser skips disabled buckets and rejects anything but a /usage answer', () => {
  const disabledOnly = [{ buckets: [{ disabled: true, remaining_fraction: 0.5, window: '5h' }, { window: 'weekly' }], name: 'Gemini Models' }];
  for (const [output, message] of [
    ['not json', /did not answer \/usage/],
    [JSON.stringify({ ...usageAnswer(), status: 'ERROR' }), /did not answer \/usage/],
    [JSON.stringify({ ...usageAnswer(), command: { data: {}, name: 'model' } }), /did not answer \/usage/],
    // An agy that took "/usage" for a prompt answers with a turn and no command.
    [JSON.stringify({ response: 'Here is your usage', status: 'SUCCESS' }), /did not answer \/usage/],
    [JSON.stringify(usageAnswer(disabledOnly)), /no quota windows/],
  ] as const) {
    const parsed = parseAntigravityUsageOutput(output);
    assert.equal(parsed.error?.type, 'parse_error');
    assert.match(parsed.error?.message ?? '', message);
    assert.deepEqual(parsed.windows, []);
  }
  const mixed = parseAntigravityUsageOutput(JSON.stringify(usageAnswer([
    { buckets: [{ disabled: true, remaining_fraction: 0.5, window: '5h' }, { remaining_fraction: 0.5, window: 'weekly' }], name: 'Gemini Models' },
  ])));
  assert.deepEqual(mixed.windows.map((window) => window.label), ['Weekly Gemini']);
});

/**
 * A fake `agy`: records its directory and arguments in calls.log, prints AGY_VERSION
 * for `--version`, and otherwise writes AGY_STDERR, exits AGY_EXIT, or prints usage.json.
 * With AGY_SLASH_COMMANDS_OFF it acts like agy with `disableSlashCommands: true` in its
 * settings: unless `--settings` turns slash commands back on, `/usage` goes to the
 * model, which it records as a "model request" line.
 */
async function fakeAgy(t: TestContext): Promise<{ calls: () => Promise<string[]>; command: string; dir: string }> {
  // Real path: the fake reports its working directory as the shell resolves it.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anima-agy-usage-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const command = join(root, 'agy');
  await writeFile(
    command,
    [
      '#!/bin/sh',
      'printf \'%s|%s\\n\' "$PWD" "$*" >> "$AGY_CALLS"',
      'if [ "$1" = --version ]; then printf \'%s\\n\' "$AGY_VERSION"; exit 0; fi',
      'if [ -n "$AGY_STDERR" ]; then printf \'%b\' "$AGY_STDERR" >&2; fi',
      'if [ -n "$AGY_EXIT" ]; then exit "$AGY_EXIT"; fi',
      'if [ -n "$AGY_SLASH_COMMANDS_OFF" ]; then',
      '  case " $* " in',
      '    *\' --settings {"disableSlashCommands":false} \'*) ;;',
      '    *) echo "model request" >> "$AGY_CALLS"; echo \'{"status":"SUCCESS","response":"ok","num_turns":1}\'; exit 0 ;;',
      '  esac',
      'fi',
      'cat "$AGY_USAGE"',
      '',
    ].join('\n'),
  );
  await chmod(command, 0o755);
  await writeFile(join(root, 'usage.json'), JSON.stringify(usageAnswer()));
  const calls = async () => (await readFile(join(root, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { calls, command, dir: join(root, 'probe') };
}

function agyEnv(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGY_CALLS: join(root, 'calls.log'),
    AGY_USAGE: join(root, 'usage.json'),
    AGY_VERSION: '1.5.18',
    ...extra,
  };
}

test('Antigravity usage asks agy /usage from its own directory with a log file there', async (t) => {
  const agy = await fakeAgy(t);
  const root = join(agy.dir, '..');
  const usage = await fetchAntigravityUsage({ command: agy.command, dir: agy.dir, env: agyEnv(root) });
  assert.equal(usage.status, 'available');
  assert.deepEqual(usage.windows.map((window) => `${window.label} ${window.remainingPercent}`), [
    '5h Gemini 25',
    'Weekly Gemini 98',
    '5h Claude/GPT 100',
    'Weekly Claude/GPT 100',
  ]);
  assert.deepEqual(await agy.calls(), [
    `${agy.dir}|--version`,
    `${agy.dir}|--log-file ${join(agy.dir, 'agy.log')} --settings {"disableSlashCommands":false} -p /usage --output-format json`,
  ]);
});

test('Antigravity usage keeps /usage a command when agy settings turn slash commands off', async (t) => {
  const agy = await fakeAgy(t);
  const usage = await fetchAntigravityUsage({
    command: agy.command,
    dir: agy.dir,
    env: agyEnv(join(agy.dir, '..'), { AGY_SLASH_COMMANDS_OFF: '1' }),
  });
  assert.equal(usage.status, 'available');
  assert.equal(usage.windows.length, 4);
  assert.equal((await agy.calls()).filter((call) => call === 'model request').length, 0);
});

test('Antigravity usage never sends /usage to an agy too old to answer it without a turn', async (t) => {
  for (const [version, message] of [
    ['1.1.10', /Antigravity CLI 1\.1\.10 cannot report quota; 1\.1\.11 or later can/],
    ['0.9.30', /0\.9\.30 cannot report quota/],
    ['agy (development build)', /Could not read the Antigravity CLI version/],
  ] as const) {
    const agy = await fakeAgy(t);
    const usage = await fetchAntigravityUsage({
      command: agy.command,
      dir: agy.dir,
      env: agyEnv(join(agy.dir, '..'), { AGY_VERSION: version }),
    });
    assert.equal(usage.status, 'unavailable', version);
    assert.equal(usage.error?.type, 'unknown');
    assert.match(usage.error?.message ?? '', message);
    assert.deepEqual(await agy.calls(), [`${agy.dir}|--version`], version);
  }
  for (const version of ['1.1.11', '1.2.0', '2.0.0']) {
    const agy = await fakeAgy(t);
    const usage = await fetchAntigravityUsage({
      command: agy.command,
      dir: agy.dir,
      env: agyEnv(join(agy.dir, '..'), { AGY_VERSION: version }),
    });
    assert.equal(usage.status, 'available', version);
  }
});

test('Antigravity usage explains an API-key sign-in, a failed run and a missing agy', async (t) => {
  const apiKey = await fakeAgy(t);
  const keyUsage = await fetchAntigravityUsage({
    command: apiKey.command,
    dir: apiKey.dir,
    env: agyEnv(join(apiKey.dir, '..'), { AGY_EXIT: '2', AGY_STDERR: 'no account quota\\n' }),
  });
  assert.equal(keyUsage.status, 'unavailable');
  assert.equal(keyUsage.error?.type, 'not_configured');
  assert.match(keyUsage.error?.message ?? '', /API key, which has no account quota/);

  const noSettings = await fakeAgy(t);
  const noSettingsUsage = await fetchAntigravityUsage({
    command: noSettings.command,
    dir: noSettings.dir,
    env: agyEnv(join(noSettings.dir, '..'), {
      AGY_EXIT: '2',
      AGY_STDERR: 'flags provided but not defined: -settings\\nUsage of agy:\\n  --add-dir  Add a directory\\n',
    }),
  });
  assert.equal(noSettingsUsage.status, 'unavailable');
  assert.equal(noSettingsUsage.error?.type, 'unknown');
  assert.match(noSettingsUsage.error?.message ?? '', /does not accept `--settings`.*agy update/);

  const failed = await fakeAgy(t);
  const failedUsage = await fetchAntigravityUsage({
    command: failed.command,
    dir: failed.dir,
    env: agyEnv(join(failed.dir, '..'), { AGY_EXIT: '1', AGY_STDERR: 'starting\\nNot signed in. Run agy to sign in.\\n' }),
  });
  assert.equal(failedUsage.status, 'unavailable');
  assert.equal(failedUsage.error?.type, 'unknown');
  assert.equal(failedUsage.error?.message, '`agy -p /usage` exited with code 1: Not signed in. Run agy to sign in.');

  const missing = await fetchAntigravityUsage({
    command: join(failed.dir, '..', 'no-such-agy'),
    dir: failed.dir,
    env: process.env,
  });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.error?.type, 'not_configured');
  assert.match(missing.error?.message ?? '', /Antigravity CLI not found/);
});

test('Antigravity usage never starts the Antigravity app\'s editor launcher', async (t) => {
  const agy = await fakeAgy(t);
  const root = join(agy.dir, '..');
  const bin = join(root, 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin');
  await mkdir(bin, { recursive: true });
  await copyFile(agy.command, join(bin, 'agy'));
  await chmod(join(bin, 'agy'), 0o755);
  const usage = await fetchAntigravityUsage({ command: 'agy', dir: agy.dir, env: agyEnv(root, { PATH: `${bin}:${process.env.PATH ?? ''}` }) });
  assert.equal(usage.status, 'unavailable');
  assert.equal(usage.error?.type, 'not_configured');
  assert.match(usage.error?.message ?? '', /the Antigravity app's editor launcher, not Antigravity CLI/);
  assert.deepEqual(await agy.calls(), []);
});

test('Antigravity usage gives up on an agy that does not answer, and stops it', async (t) => {
  const agy = await fakeAgy(t);
  const root = join(agy.dir, '..');
  const hang = join(root, 'agy-hang');
  // Answers --version, then hangs in a grandchild the way a wrapper's CLI would.
  await writeFile(
    hang,
    [
      '#!/bin/sh',
      'if [ "$1" = --version ]; then echo 1.5.18; exit 0; fi',
      `sleep 30 & echo $! > ${JSON.stringify(join(root, 'sleep.pid'))}`,
      'wait',
      '',
    ].join('\n'),
  );
  await chmod(hang, 0o755);
  const started = Date.now();
  const usage = await fetchAntigravityUsage({ command: hang, dir: agy.dir, env: process.env, killGraceMs: 100, timeoutMs: 1_000 });
  assert.ok(Date.now() - started < 10_000);
  assert.equal(usage.status, 'unavailable');
  assert.match(usage.error?.message ?? '', /`agy -p \/usage` did not finish within 1000 ms/);
  const pid = Number((await readFile(join(root, 'sleep.pid'), 'utf8')).trim());
  assert.ok(pid > 0);
  // The group was stopped before the call returned; allow the orphan's reaping.
  const deadline = Date.now() + 2_000;
  while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  try {
    assert.equal(alive(pid), false, 'the CLI the wrapper started was stopped with it');
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
