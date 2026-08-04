import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { REMINDER_BODY_MAX_CHARS } from '../reminders/preflight.js';

const cliPath = resolve('dist/server/cli/anima.js');

test('reminder preflight CLI runs once in target Agent Home with hosted env parity and no state', async () => {
  await withPreflightAgent(async ({ agentDir, agentHome, env }) => {
    const statePaths = [
      join(agentDir, 'reminders.json'),
      join(agentDir, 'wake-queue.json'),
      join(agentDir, 'activity.jsonl'),
    ];
    await writeFile(statePaths[0]!, '{}\n');
    await writeFile(statePaths[1]!, '{"items":{},"seen":{}}\n');
    await writeFile(statePaths[2]!, '');
    const before = await Promise.all(statePaths.map((path) => readFile(path, 'utf8')));

    const command = [
      'test -f agent-home-marker',
      'printf "cwd=%s\\n" "$PWD"',
      'printf "provider=%s slack=%s agent=%s\\n" "$PREFLIGHT_PROVIDER_VALUE" "$SLACK_BOT_TOKEN" "$ANIMA_AGENT_ID"',
      'printf "reminder=%s item=%s channel=%s session=%s workspace=%s surface=%s\\n" "${ANIMA_REMINDER_ID-unset}" "${ANIMA_INBOX_ITEM_ID-unset}" "${ANIMA_CHANNEL_ID-unset}" "${ANIMA_SESSION_KEY-unset}" "${ANIMA_WORKSPACE_PATH-unset}" "${ANIMA_SURFACE_KIND-unset}"',
      'printf "debug stderr\\n" >&2',
    ].join(' && ');
    const run = await runCli(['reminder', 'preflight', '--command', command], {
      ...env,
      ANIMA_CHANNEL_ID: 'C_TRANSIENT',
      ANIMA_INBOX_ITEM_ID: 'item-transient',
      ANIMA_REMINDER_ID: 'reminder-transient',
      ANIMA_SESSION_KEY: 'session-transient',
      ANIMA_SURFACE_KIND: 'thread',
      ANIMA_WORKSPACE_PATH: '/transient/workspace',
      PREFLIGHT_PROVIDER_VALUE: 'configured-provider',
      SLACK_BOT_TOKEN: 'managed-slack',
    });

    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, new RegExp(`cwd=${escapeRegExp(await realpath(agentHome))}`));
    assert.match(run.stdout, /provider=configured-provider slack=managed-slack agent=scout/);
    assert.match(run.stdout, /reminder=unset item=unset channel=unset session=unset workspace=unset surface=unset/);
    assert.match(run.stdout, /stdout:\n/);
    assert.match(run.stdout, /stderr:\ndebug stderr/);
    assert.match(run.stdout, /result: succeeds; hosted reminder would wake/);
    assert.match(run.stdout, /duration_ms=\d+ exit=0/);
    assert.deepEqual(await Promise.all(statePaths.map((path) => readFile(path, 'utf8'))), before);
  });
});

test('reminder preflight CLI preserves classified exit semantics', async () => {
  await withPreflightAgent(async ({ env }) => {
    const declined = await runCli(['reminder', 'preflight', '--command', 'exit 1'], env);
    assert.equal(declined.status, 1);
    assert.match(declined.stdout, /result: declines; hosted reminder would skip/);
    assert.match(declined.stdout, /exit=1/);

    const errored = await runCli(['reminder', 'preflight', '--command', 'exit 7'], env);
    assert.equal(errored.status, 7);
    assert.match(errored.stdout, /result: errors; hosted reminder would report Needs attention/);
    assert.match(errored.stdout, /exit=7/);

    const signaled = await runCli(['reminder', 'preflight', '--command', 'kill -TERM $$'], env);
    assert.equal(signaled.status, 143);
    assert.match(signaled.stdout, /signal=SIGTERM/);
  });
});

test('reminder preflight CLI times out with 124 and reports bounded output honestly', async () => {
  await withPreflightAgent(async ({ env }) => {
    const timedOut = await runCli([
      'reminder', 'preflight', '--command', 'printf before-timeout; sleep 30', '--timeout', '1s',
    ], env);
    assert.equal(timedOut.status, 124, timedOut.stderr || timedOut.stdout);
    assert.match(timedOut.stdout, /before-timeout/);
    assert.match(timedOut.stdout, /result: errors; hosted reminder would report Needs attention/);
    assert.match(timedOut.stdout, /duration_ms=\d+ timeout/);

    const truncated = await runCli([
      'reminder', 'preflight', '--command',
      `node -e "process.stdout.write('x'.repeat(${REMINDER_BODY_MAX_CHARS + 10})); process.stderr.write('y'.repeat(${REMINDER_BODY_MAX_CHARS + 10}))"`,
    ], env);
    assert.equal(truncated.status, 0, truncated.stderr || truncated.stdout);
    assert.match(truncated.stdout, /\[preflight stdout truncated at 32000 characters\]/);
    assert.match(truncated.stdout, /\[preflight stderr truncated at 32000 characters\]/);
  });
});

test('reminder preflight CLI fails closed without current agent context', async () => {
  await withPreflightAgent(async ({ env }) => {
    delete env.ANIMA_AGENT_ID;
    const run = await runCli(['reminder', 'preflight', '--command', 'exit 0'], env);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /ANIMA_AGENT_ID is required/);
  });
});

test('reminder help and agent reference teach Write → Run → Schedule without banned vocabulary', async () => {
  const reminderHelp = await runCli(['reminder', '--help'], process.env);
  const commandHelp = await runCli(['reminder', 'preflight', '--help'], process.env);
  const scheduleHelp = await runCli(['reminder', 'schedule', '--help'], process.env);
  assert.equal(reminderHelp.status, 0, reminderHelp.stderr);
  assert.equal(commandHelp.status, 0, commandHelp.stderr);
  assert.equal(scheduleHelp.status, 0, scheduleHelp.stderr);
  for (const text of [reminderHelp.stdout, commandHelp.stdout, scheduleHelp.stdout]) {
    assert.match(text, /Write → Run → Schedule/);
    assert.match(text, /anima reminder preflight --command '.\/scripts\/check-usage\.sh' --timeout 2m/);
    assert.match(text, /anima reminder schedule .*--preflight .\/scripts\/check-usage\.sh --preflight-timeout 2m/);
  }
  assert.match(commandHelp.stdout, /Run this from the target agent/);
  assert.match(commandHelp.stdout, /same Agent Home and configured\/managed/);
  assert.match(commandHelp.stdout, /No message context is invented/);
  assert.match(commandHelp.stdout, /no reminder, wake,/);

  const docs = await readFile(resolve('docs/agent/reference.md'), 'utf8');
  assert.match(docs, /Write → Run → Schedule/);
  assert.match(docs, /CWD is that\nagent's Agent Home/);
  assert.match(docs, /creates no reminder, wake, activity, or other\ndurable state/);
  assert.match(docs, /--window mon-fri@08:00-18:30/);
  for (const surface of [reminderHelp.stdout, commandHelp.stdout, scheduleHelp.stdout, docs]) {
    const lower = surface.toLowerCase();
    for (const banned of ['true/false', 'pass/fail', 'true = ', 'false = ', 'pass =', 'fail =']) {
      assert.ok(!lower.includes(banned), `banned preflight wording: ${banned}`);
    }
  }
});

async function withPreflightAgent(
  body: (fixture: {
    agentDir: string;
    agentHome: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'anima-preflight-cli-'));
  const animaHome = join(root, '.anima');
  const agentDir = join(animaHome, 'agents', 'scout');
  const agentHome = join(root, 'scout-home');
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(agentHome, { recursive: true });
    await writeFile(join(agentHome, 'agent-home-marker'), 'here\n');
    await writeFile(join(animaHome, 'config.json'), '{}\n');
    await writeFile(join(agentDir, 'config.json'), `${JSON.stringify({
      homePath: agentHome,
      id: 'scout',
      provider: { kind: 'codex-cli', model: 'gpt-5.5' },
      slack: { appToken: 'xapp', botToken: 'xoxb', connected: true },
    })}\n`);
    await body({
      agentDir,
      agentHome,
      env: { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: animaHome },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = (await once(child, 'exit')) as [number | null];
  return { status, stderr, stdout };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
