import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseHandoffRequest } from '../../shared/secret-handoff.js';

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

test('env handoff CLI transfers a secret once, preserves sender policy, and requires explicit replace', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-env-handoff-test-'));
  const envFor = (agentId: string) => ({ ...process.env, ANIMA_AGENT_ID: agentId, ANIMA_HOME: stateDir });
  const specimen = 'handoff-secret-specimen';
  try {
    const seed = await runNode([cliPath, 'env', 'set', 'SOURCE_TOKEN', '--secret'], {
      env: envFor('nora'),
      input: `${specimen}\n`,
    });
    assert.equal(seed.status, 0, seed.stderr || seed.stdout);

    const request = await runNode([
      cliPath,
      'env',
      'handoff',
      'request',
      'SERVICE_TOKEN',
      '--purpose',
      'Run the release verification job',
      '--from',
      'nora',
    ], { env: envFor('milo') });
    assert.equal(request.status, 0, request.stderr || request.stdout);
    const requestCode = extractHandoffCode(request.stdout, 'asec_req_v1_');
    assert.doesNotMatch(request.stdout, new RegExp(specimen));
    assert.match(request.stdout, /Purpose: Run the release verification job/);
    assert.match(request.stdout, /Sender: `nora`/);
    assert.match(request.stdout, /Expires: <t:\d+:f>/);

    const pendingFiles = join(stateDir, 'agents', 'milo', 'env', 'handoff');
    assert.equal((await stat(pendingFiles)).mode & 0o777, 0o700);
    const pendingFile = join(pendingFiles, `${request.stdout.match(/id=([A-Za-z0-9_-]{22})/)?.[1]}.json`);
    assert.equal((await stat(pendingFile)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(pendingFile, 'utf8'), new RegExp(specimen));

    const wrongSender = await runNode([
      cliPath,
      'env',
      'handoff',
      'send',
      requestCode,
      '--from-key',
      'SOURCE_TOKEN',
    ], { env: envFor('aria') });
    assert.equal(wrongSender.status, 1);
    assert.match(wrongSender.stderr, /expects sender nora/);

    const send = await runNode([
      cliPath,
      'env',
      'handoff',
      'send',
      requestCode,
      '--from-key',
      'SOURCE_TOKEN',
    ], { env: envFor('nora') });
    assert.equal(send.status, 0, send.stderr || send.stdout);
    const boxCode = extractHandoffCode(send.stdout, 'asec_box_v1_');
    assert.doesNotMatch(send.stdout, new RegExp(specimen));

    const accept = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      boxCode,
    ], { env: envFor('milo') });
    assert.equal(accept.status, 0, accept.stderr || accept.stdout);
    assert.match(accept.stdout, /handoff accepted successfully/);
    assert.match(accept.stdout, /key=SERVICE_TOKEN/);
    assert.doesNotMatch(accept.stdout, new RegExp(specimen));

    const reveal = await runNode([
      cliPath,
      'env',
      'run',
      '--keys',
      'SERVICE_TOKEN',
      '--',
      process.execPath,
      '-e',
      'process.stdout.write(process.env.SERVICE_TOKEN || "")',
    ], { env: envFor('milo') });
    assert.equal(reveal.stdout, specimen);
    const replay = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      boxCode,
    ], { env: envFor('milo') });
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /not found/);

    const replaceRequest = await runNode([
      cliPath,
      'env',
      'handoff',
      'request',
      'SERVICE_TOKEN',
      '--purpose',
      'Rotate the release verification credential',
      '--from',
      'nora',
    ], { env: envFor('milo') });
    const replaceRequestCode = extractHandoffCode(replaceRequest.stdout, 'asec_req_v1_');
    const replaceSend = await runNode([
      cliPath,
      'env',
      'handoff',
      'send',
      replaceRequestCode,
      '--from-key',
      'SOURCE_TOKEN',
    ], { env: envFor('nora') });
    const replaceBox = extractHandoffCode(replaceSend.stdout, 'asec_box_v1_');
    const rejectExisting = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      replaceBox,
    ], { env: envFor('milo') });
    assert.equal(rejectExisting.status, 1);
    assert.match(rejectExisting.stderr, /Pass --replace/);
    const replace = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      replaceBox,
      '--replace',
    ], { env: envFor('milo') });
    assert.equal(replace.status, 0, replace.stderr || replace.stdout);

    const invalidPolicy = await runNode([
      cliPath,
      'env',
      'handoff',
      'request',
      'OTHER_TOKEN',
      '--purpose',
      'Invalid broad request',
    ], { env: envFor('milo') });
    assert.equal(invalidPolicy.status, 1);
    assert.match(invalidPolicy.stderr, /Choose exactly one sender policy/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('env handoff CLI bounds expiry and destroys cancelled receive keys', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-env-cancel-handoff-test-'));
  const env = { ...process.env, ANIMA_AGENT_ID: 'milo', ANIMA_HOME: stateDir };
  try {
    const request = await runNode([
      cliPath,
      'env',
      'handoff',
      'request',
      'SERVICE_TOKEN',
      '--purpose',
      'Configure the release verification service',
      '--from',
      'nora',
      '--expires',
      '24h',
    ], { env });
    assert.equal(request.status, 0, request.stderr || request.stdout);
    assert.match(request.stdout, /asec_req_v1_/);
    assert.match(request.stdout, /sender=nora/);
    const requestId = request.stdout.match(/id=([A-Za-z0-9_-]{22})/)?.[1];
    assert.ok(requestId);

    const cancel = await runNode([
      cliPath,
      'env',
      'handoff',
      'cancel',
      requestId,
    ], { env });
    assert.equal(cancel.status, 0, cancel.stderr || cancel.stdout);
    assert.match(cancel.stdout, /handoff cancelled successfully/);
    const replayCancel = await runNode([
      cliPath,
      'env',
      'handoff',
      'cancel',
      requestId,
    ], { env });
    assert.equal(replayCancel.status, 1);
    assert.match(replayCancel.stderr, /not found/);

    for (const expiry of ['4m', '8d', '1.5h', 'tomorrow']) {
      const invalid = await runNode([
        cliPath,
        'env',
        'handoff',
        'request',
        'OTHER_TOKEN',
        '--purpose',
        'Reject invalid expiry',
        '--from',
        'nora',
        '--expires',
        expiry,
      ], { env });
      assert.equal(invalid.status, 1, `${expiry}: ${invalid.stderr || invalid.stdout}`);
      assert.match(invalid.stderr, /Expiry must/);
    }
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('env handoff CLI creates a browser-only human request with bound workspace metadata', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-human-handoff-test-'));
  const agentDir = join(stateDir, 'agents', 'milo');
  const homePath = join(stateDir, 'home');
  const env = { ...process.env, ANIMA_AGENT_ID: 'milo', ANIMA_HOME: stateDir };
  try {
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(homePath, { recursive: true }),
    ]);
    await writeFile(
      join(agentDir, 'config.json'),
      `${JSON.stringify({
        id: 'milo',
        homePath,
        provider: { kind: 'codex-cli', model: 'gpt-5.5' },
        slack: {
          appToken: 'xapp-test',
          botToken: 'xoxb-test',
          connected: true,
          teamId: 'T01234567',
          workspaceName: 'Anima Team',
        },
      }, null, 2)}\n`,
      'utf8',
    );

    const disabled = await runNode([
      cliPath,
      'env',
      'handoff',
      'request',
      'SERVICE_TOKEN',
      '--purpose',
      'Run the deployment verification job',
      '--from-human',
    ], { env });
    assert.equal(disabled.status, 1);
    assert.match(disabled.stderr, /not enabled until the secure page deployment is verified/);
    assert.doesNotMatch(disabled.stderr + disabled.stdout, /handoff\.meetanima\.online/);
    await assert.rejects(stat(join(agentDir, 'env', 'handoff')), { code: 'ENOENT' });

    const untrusted = await runNode([
      cliPath,
      'env',
      'handoff',
      'request',
      'SERVICE_TOKEN',
      '--purpose',
      'Reject an untrusted browser origin',
      '--from-human',
    ], {
      env: { ...env, ANIMA_HUMAN_HANDOFF_PAGE_ORIGIN: 'https://example.com' },
    });
    assert.equal(untrusted.status, 1);
    assert.match(untrusted.stderr, /origin is not trusted by this build/);
    assert.doesNotMatch(untrusted.stderr + untrusted.stdout, /example\.com/);

    const enabledEnv = {
      ...env,
      ANIMA_HUMAN_HANDOFF_PAGE_ORIGIN: 'https://handoff.meetanima.online',
    };
    const result = await runNode([
      cliPath,
      'env',
      'handoff',
      'request',
      'SERVICE_TOKEN',
      '--purpose',
      'Run the deployment verification job',
      '--from-human',
    ], { env: enabledEnv });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Destination: milo's local encrypted env/);
    assert.match(result.stdout, /Workspace: Anima Team/);
    assert.match(result.stdout, /Slack and the Anima handoff page never receive the plaintext/);
    assert.match(
      result.stdout,
      /<https:\/\/handoff\.meetanima\.online\/#asec_req_v1_[A-Za-z0-9_-]+\|Securely provide secret>/,
    );
    assert.ok(result.stdout.length < 12_000);

    const code = extractHandoffCode(result.stdout, 'asec_req_v1_');
    const request = parseHandoffRequest(code);
    assert.equal(request.senderKind, 'human');
    if (request.senderKind !== 'human') return;
    assert.equal(request.workspaceId, 'T01234567');
    assert.equal(request.workspaceName, 'Anima Team');
    assert.equal(request.purpose, 'Run the deployment verification job');

    const conflicting = await runNode([
      cliPath,
      'env',
      'handoff',
      'request',
      'OTHER_TOKEN',
      '--purpose',
      'Reject ambiguous sender policy',
      '--from-human',
      '--from',
      'nora',
    ], { env: enabledEnv });
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr, /Choose exactly one sender policy/);
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

function extractHandoffCode(output: string, prefix: string): string {
  const match = output.match(new RegExp(`${prefix}[A-Za-z0-9_-]+`));
  assert.ok(match, `Expected ${prefix} code in output: ${output}`);
  return match[0];
}
