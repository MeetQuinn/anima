import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHandoffKeyPair,
  createHandoffRequest,
  encodeHandoffRequest,
  encryptSealedHandoffSecret,
} from '../../shared/secret-handoff.js';
import { SecretHandoffPendingStore } from '../env/secret-handoff-store.js';

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

test('env handoff CLI transfers one sealed secret between agents and chooses the key on accept', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-env-handoff-test-'));
  const envFor = (agentId: string) => ({ ...process.env, ANIMA_AGENT_ID: agentId, ANIMA_HOME: stateDir });
  const specimen = 'handoff-secret-specimen';
  try {
    const seed = await runNode([cliPath, 'env', 'set', 'SOURCE_TOKEN', '--secret'], {
      env: envFor('nora'),
      input: `${specimen}\n`,
    });
    assert.equal(seed.status, 0, seed.stderr || seed.stdout);

    const receive = await runNode([cliPath, 'env', 'handoff', 'receive'], {
      env: envFor('milo'),
    });
    assert.equal(receive.status, 0, receive.stderr || receive.stdout);
    const publicKey = extractHandoffCode(receive.stdout, 'asec_key_v1_');
    assert.doesNotMatch(receive.stdout, /SERVICE_TOKEN|workspace|purpose|recipient/i);
    const malformedKey = await runNode([
      cliPath,
      'env',
      'handoff',
      'send',
      'asec_key_v1_bad',
      '--from-key',
      'MISSING_TOKEN',
    ], { env: envFor('nora') });
    assert.equal(malformedKey.status, 1);
    assert.match(malformedKey.stderr, /public key is invalid/);
    assert.doesNotMatch(malformedKey.stderr, /MISSING_TOKEN/);

    const pendingFiles = join(stateDir, 'agents', 'milo', 'env', 'handoff', 'human');
    assert.equal((await stat(pendingFiles)).mode & 0o777, 0o700);
    const pendingFile = join(
      pendingFiles,
      `${receive.stdout.match(/id=(s_[A-Za-z0-9_-]{22})/)?.[1]}.json`,
    );
    assert.equal((await stat(pendingFile)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(pendingFile, 'utf8'), new RegExp(specimen));

    const send = await runNode([
      cliPath,
      'env',
      'handoff',
      'send',
      publicKey,
      '--from-key',
      'SOURCE_TOKEN',
    ], { env: envFor('nora') });
    assert.equal(send.status, 0, send.stderr || send.stdout);
    const boxCode = extractHandoffCode(send.stdout, 'asec_sealed_v1_');
    assert.doesNotMatch(send.stdout, new RegExp(specimen));
    assert.doesNotMatch(send.stdout, /SOURCE_TOKEN/);
    assert.doesNotMatch(boxCode, /milo|nora|SERVICE_TOKEN/i);

    const accept = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      boxCode,
      '--key',
      'SERVICE_TOKEN',
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
      '--key',
      'REPLAY_TOKEN',
    ], { env: envFor('milo') });
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /not found/);

    const replaceReceive = await runNode([cliPath, 'env', 'handoff', 'receive'], {
      env: envFor('milo'),
    });
    const replacePublicKey = extractHandoffCode(replaceReceive.stdout, 'asec_key_v1_');
    const replaceSend = await runNode([
      cliPath,
      'env',
      'handoff',
      'send',
      replacePublicKey,
      '--from-key',
      'SOURCE_TOKEN',
    ], { env: envFor('nora') });
    const replaceBox = extractHandoffCode(replaceSend.stdout, 'asec_sealed_v1_');
    const rejectExisting = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      replaceBox,
      '--key',
      'SERVICE_TOKEN',
    ], { env: envFor('milo') });
    assert.equal(rejectExisting.status, 1);
    assert.match(rejectExisting.stderr, /Pass --replace/);
    const replace = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      replaceBox,
      '--key',
      'SERVICE_TOKEN',
      '--replace',
    ], { env: envFor('milo') });
    assert.equal(replace.status, 0, replace.stderr || replace.stdout);

    const legacyKeys = createHandoffKeyPair();
    const legacyRequest = createHandoffRequest({
      recipientAgentId: 'milo',
      targetKey: 'LEGACY_TOKEN',
      purpose: 'Complete an in-flight request after upgrade',
      sender: { kind: 'agent', agentId: 'nora' },
      expiresAt: new Date(Date.now() + 10 * 60_000),
      publicKey: legacyKeys.publicKey,
    });
    await new SecretHandoffPendingStore('milo', stateDir).create(
      legacyRequest,
      legacyKeys.privateKey,
    );
    const wrongLegacySender = await runNode([
      cliPath,
      'env',
      'handoff',
      'send',
      encodeHandoffRequest(legacyRequest),
      '--from-key',
      'MISSING_TOKEN',
    ], { env: envFor('aria') });
    assert.equal(wrongLegacySender.status, 1);
    assert.match(wrongLegacySender.stderr, /expects sender nora/);
    assert.doesNotMatch(wrongLegacySender.stderr, /MISSING_TOKEN/);
    const legacySend = await runNode([
      cliPath,
      'env',
      'handoff',
      'send',
      encodeHandoffRequest(legacyRequest),
      '--from-key',
      'SOURCE_TOKEN',
    ], { env: envFor('nora') });
    assert.equal(legacySend.status, 0, legacySend.stderr || legacySend.stdout);
    const legacyBox = extractHandoffCode(legacySend.stdout, 'asec_box_v1_');
    const legacyAccept = await runNode(
      [cliPath, 'env', 'handoff', 'accept', legacyBox],
      { env: envFor('milo') },
    );
    assert.equal(legacyAccept.status, 0, legacyAccept.stderr || legacyAccept.stdout);
    assert.match(legacyAccept.stdout, /key=LEGACY_TOKEN/);

    const retiredRequest = await runNode([
      cliPath,
      'env',
      'handoff',
      'request',
      'SERVICE_TOKEN',
    ], { env: envFor('milo') });
    assert.equal(retiredRequest.status, 1);
    assert.match(retiredRequest.stderr, /input\.invalid_options/);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('env handoff CLI bounds expiry, cancels sealed keys, and routes legacy ids by full shape', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-env-cancel-handoff-test-'));
  const env = { ...process.env, ANIMA_AGENT_ID: 'milo', ANIMA_HOME: stateDir };
  try {
    const receive = await runNode([
      cliPath,
      'env',
      'handoff',
      'receive',
      '--expires',
      '24h',
    ], { env });
    assert.equal(receive.status, 0, receive.stderr || receive.stdout);
    assert.match(receive.stdout, /asec_key_v1_/);
    const requestId = receive.stdout.match(/id=(s_[A-Za-z0-9_-]{22})/)?.[1];
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
        'receive',
        '--expires',
        expiry,
      ], { env });
      assert.equal(invalid.status, 1, `${expiry}: ${invalid.stderr || invalid.stdout}`);
      assert.match(invalid.stderr, /Expiry must/);
    }

    const legacyId = `s_${'a'.repeat(20)}`;
    const legacyKeys = createHandoffKeyPair();
    const legacyRequest = createHandoffRequest({
      requestId: legacyId,
      recipientAgentId: 'milo',
      targetKey: 'LEGACY_TOKEN',
      purpose: 'Verify full-shape cancel routing',
      sender: { kind: 'agent', agentId: 'nora' },
      expiresAt: new Date(Date.now() + 10 * 60_000),
      publicKey: legacyKeys.publicKey,
    });
    await new SecretHandoffPendingStore('milo', stateDir).create(
      legacyRequest,
      legacyKeys.privateKey,
    );
    const legacyCancel = await runNode(
      [cliPath, 'env', 'handoff', 'cancel', legacyId],
      { env },
    );
    assert.equal(legacyCancel.status, 0, legacyCancel.stderr || legacyCancel.stdout);
  } finally {
    await rm(stateDir, { force: true, recursive: true });
  }
});

test('env handoff CLI browser link uses the same public key and sealed box protocol', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-cli-browser-handoff-test-'));
  const env = { ...process.env, ANIMA_AGENT_ID: 'milo', ANIMA_HOME: stateDir };
  const specimen = 'browser-generated-secret-specimen';
  try {
    const result = await runNode([
      cliPath,
      'env',
      'handoff',
      'receive',
      '--expires',
      '24h',
    ], { env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      /<https:\/\/handoff\.meetanima\.online\/#asec_key_v1_[0-9a-f]{66}\|Encrypt a secret>/,
    );
    assert.match(result.stdout, /id=s_[A-Za-z0-9_-]{22}/);
    assert.doesNotMatch(result.stdout, /SERVICE_TOKEN|workspace|purpose|recipient/i);
    const publicCode = result.stdout.match(/asec_key_v1_[0-9a-f]{66}/)?.[0];
    assert.ok(publicCode);
    const box = await encryptSealedHandoffSecret(publicCode, specimen);
    assert.doesNotMatch(box, new RegExp(specimen));

    const missingKey = await runNode([cliPath, 'env', 'handoff', 'accept', box], { env });
    assert.equal(missingKey.status, 1);
    assert.match(missingKey.stderr, /Pass --key <key>/);

    const accepted = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      box,
      '--key',
      'SERVICE_TOKEN',
    ], { env });
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    assert.match(accepted.stdout, /key=SERVICE_TOKEN/);
    assert.doesNotMatch(accepted.stdout, new RegExp(specimen));

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
    ], { env });
    assert.equal(reveal.stdout, specimen);

    const replay = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      box,
      '--key',
      'ANOTHER_TOKEN',
    ], { env });
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /not found/);

    const replaceReceive = await runNode([cliPath, 'env', 'handoff', 'receive'], { env });
    const replaceCode = replaceReceive.stdout.match(/asec_key_v1_[0-9a-f]{66}/)?.[0];
    assert.ok(replaceCode);
    const replaceBox = await encryptSealedHandoffSecret(replaceCode, 'replacement-specimen');
    const rejectExisting = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      replaceBox,
      '--key',
      'SERVICE_TOKEN',
    ], { env });
    assert.equal(rejectExisting.status, 1);
    assert.match(rejectExisting.stderr, /Pass --replace/);
    const replace = await runNode([
      cliPath,
      'env',
      'handoff',
      'accept',
      replaceBox,
      '--key',
      'SERVICE_TOKEN',
      '--replace',
    ], { env });
    assert.equal(replace.status, 0, replace.stderr || replace.stdout);

    const staleOverride = await runNode([
      cliPath,
      'env',
      'handoff',
      'receive',
    ], {
      env: { ...env, ANIMA_HUMAN_HANDOFF_PAGE_ORIGIN: 'https://example.com' },
    });
    assert.equal(staleOverride.status, 0, staleOverride.stderr || staleOverride.stdout);
    assert.match(staleOverride.stdout, /https:\/\/handoff\.meetanima\.online\/#asec_key_v1_/);
    assert.doesNotMatch(staleOverride.stderr + staleOverride.stdout, /example\.com/);
    const staleId = staleOverride.stdout.match(/id=(s_[A-Za-z0-9_-]{22})/)?.[1];
    assert.ok(staleId);
    const cancel = await runNode([
      cliPath,
      'env',
      'handoff',
      'cancel',
      staleId,
    ], { env });
    assert.equal(cancel.status, 0, cancel.stderr || cancel.stdout);
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
