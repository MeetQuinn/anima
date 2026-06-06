import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const cliPath = resolve('dist/server/cli/anima.js');

test('env CLI stores plain and encrypted secret values and injects selected keys', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-env-test-'));
  const env = { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir };
  try {
    const plain = await runNode([cliPath, 'env', 'set', 'PLAIN_VALUE', 'visible'], { env });
    assert.equal(plain.status, 0, plain.stderr || plain.stdout);
    assert.equal(plain.stdout.trim(), 'set successfully. key=PLAIN_VALUE, kind=plain.');

    const secret = await runNode([cliPath, 'env', 'set', 'SERVICE_TOKEN', '--secret'], {
      env,
      input: 'super-secret\n',
    });
    assert.equal(secret.status, 0, secret.stderr || secret.stdout);
    assert.equal(secret.stdout.trim(), 'set successfully. key=SERVICE_TOKEN, kind=secret.');

    const envDir = join(stateDir, 'agents', 'scout', 'env');
    const secretFile = await readFile(join(envDir, '.env.secret'), 'utf8');
    const keysFile = await readFile(join(envDir, '.env.keys'), 'utf8');
    assert.match(secretFile, /SERVICE_TOKEN="?encrypted:/);
    assert.match(keysFile, /DOTENV_PRIVATE_KEY_SECRET=/);
    assert.doesNotMatch(secretFile, /super-secret/);
    assert.doesNotMatch(keysFile, /super-secret/);
    assert.equal(((await stat(join(envDir, '.env.secret'))).mode & 0o777), 0o600);
    assert.equal(((await stat(join(envDir, '.env.keys'))).mode & 0o777), 0o600);

    const list = await runNode([cliPath, 'env', 'list'], { env });
    assert.equal(list.status, 0, list.stderr || list.stdout);
    assert.match(list.stdout, /PLAIN_VALUE\tplain\tvisible/);
    assert.match(list.stdout, /SERVICE_TOKEN\tsecret\t\*{8}cret/);
    assert.doesNotMatch(list.stdout, /super-secret/);

    const sourcePlain = await runNode([cliPath, 'env', 'source'], { env });
    assert.equal(sourcePlain.status, 0, sourcePlain.stderr || sourcePlain.stdout);
    assert.equal(sourcePlain.stdout.trim(), "export PLAIN_VALUE='visible'");

    const sourceSecrets = await runNode([cliPath, 'env', 'source', '--secrets'], { env });
    assert.equal(sourceSecrets.status, 0, sourceSecrets.stderr || sourceSecrets.stdout);
    assert.match(sourceSecrets.stdout, /export PLAIN_VALUE='visible'/);
    assert.match(sourceSecrets.stdout, /export SERVICE_TOKEN='super-secret'/);

    const run = await runNode([
      cliPath,
      'env',
      'run',
      '--keys',
      'PLAIN_VALUE,SERVICE_TOKEN',
      '--',
      process.execPath,
      '-e',
      'console.log(JSON.stringify({ animaSlack: process.env.ANIMA_SLACK_BOT_TOKEN || "", dotenvKey: process.env.DOTENV_PRIVATE_KEY_SECRET || "", feishuSecret: process.env.FEISHU_APP_SECRET || "", feishuTenant: process.env.FEISHU_TENANT_ACCESS_TOKEN || "", plain: process.env.PLAIN_VALUE, slack: process.env.SLACK_BOT_TOKEN || "", token: process.env.SERVICE_TOKEN }))',
    ], {
      env: {
        ...env,
        ANIMA_SLACK_BOT_TOKEN: 'xoxb-managed-anima',
        DOTENV_PRIVATE_KEY_SECRET: 'should-not-leak',
        FEISHU_APP_SECRET: 'feishu-secret',
        FEISHU_TENANT_ACCESS_TOKEN: 'tenant-token',
        SLACK_BOT_TOKEN: 'xoxb-managed',
      },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.deepEqual(JSON.parse(run.stdout.trim()), {
      animaSlack: '',
      dotenvKey: '',
      feishuSecret: '',
      feishuTenant: '',
      plain: 'visible',
      slack: '',
      token: 'super-secret',
    });
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('env CLI rejects cross-file duplicates and reserved runtime keys', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-env-reserved-test-'));
  const env = { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir };
  try {
    const plain = await runNode([cliPath, 'env', 'set', 'DUPLICATE_KEY', 'plain'], { env });
    assert.equal(plain.status, 0, plain.stderr || plain.stdout);

    const duplicateSecret = await runNode([cliPath, 'env', 'set', 'DUPLICATE_KEY', '--secret'], {
      env,
      input: 'secret\n',
    });
    assert.equal(duplicateSecret.status, 1);
    assert.match(duplicateSecret.stderr, /DUPLICATE_KEY already exists as a plain env value/);

    const reserved = await runNode([cliPath, 'env', 'set', 'ANIMA_HOME', '/tmp/nope'], { env });
    assert.equal(reserved.status, 1);
    assert.match(reserved.stderr, /ANIMA_HOME is managed or unsafe/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('env CLI reads dotenv values literally without command substitution', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-env-literal-test-'));
  const env = { ...process.env, ANIMA_AGENT_ID: 'scout', ANIMA_HOME: stateDir };
  try {
    const secret = await runNode([cliPath, 'env', 'set', 'LITERAL_SECRET', '--secret'], {
      env,
      input: '$(echo should-not-execute)\n',
    });
    assert.equal(secret.status, 0, secret.stderr || secret.stdout);

    const run = await runNode([
      cliPath,
      'env',
      'run',
      '--keys',
      'LITERAL_SECRET',
      '--',
      process.execPath,
      '-e',
      'console.log(process.env.LITERAL_SECRET)',
    ], { env });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stdout.trim(), '$(echo should-not-execute)');
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

async function runNode(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(options.input);
  const [status] = (await once(child, 'exit')) as [number | null];
  return { status, stderr, stdout };
}
