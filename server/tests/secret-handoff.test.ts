import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  MAX_HANDOFF_SECRET_BYTES,
  createHandoffKeyPair,
  createHandoffRequest,
  decryptHandoffSecret,
  encodeHandoffRequest,
  encryptHandoffSecret,
  decryptHumanHandoffSecret,
  encodeHumanHandoffBox,
  encodeHumanHandoffPublicKey,
  encryptHumanHandoffSecret,
  formatHandoffBoxForSlack,
  formatHumanHandoffBoxForSlack,
  humanHandoffKeyId,
  parseHumanHandoffBox,
  parseHandoffBox,
  parseHandoffRequest,
} from '../../shared/secret-handoff.js';
import { AgentEnvStore } from '../env/agent-env-store.js';
import { SecretHandoffPendingStore } from '../env/secret-handoff-store.js';
import { HumanSecretHandoffPendingStore } from '../env/human-secret-handoff-store.js';

const future = () => new Date(Date.now() + 60 * 60 * 1000);

test('secret handoff round trips an agent secret through canonical request and fenced box', async () => {
  const keys = createHandoffKeyPair();
  const request = createHandoffRequest({
    recipientAgentId: 'milo',
    targetKey: 'SERVICE_TOKEN',
    purpose: 'Run the release verification job',
    sender: { kind: 'agent', agentId: 'nora' },
    expiresAt: future(),
    publicKey: keys.publicKey,
  });
  const requestCode = encodeHandoffRequest(request);
  assert.deepEqual(parseHandoffRequest(requestCode), request);

  const secret = 'known-secret-specimen';
  const boxCode = await encryptHandoffSecret(request, {
    sender: { kind: 'agent', agentId: 'nora' },
    value: secret,
  });
  const slackBlock = formatHandoffBoxForSlack(boxCode);
  assert.doesNotMatch(boxCode, new RegExp(secret));
  assert.equal(parseHandoffBox(slackBlock).requestId, request.requestId);

  const payload = await decryptHandoffSecret(
    request,
    keys.privateKey,
    slackBlock,
  );
  assert.equal(payload.value, secret);
  assert.equal(payload.senderKind, 'agent');
  if (payload.senderKind === 'agent')
    assert.equal(payload.senderAgentId, 'nora');
});

test('human handoff URL contains only a public key and its generic box round trips', async () => {
  const keys = createHandoffKeyPair();
  const publicCode = encodeHumanHandoffPublicKey(keys.publicKey);
  assert.equal(publicCode, `asec_key_v1_${keys.publicKey}`);
  assert.doesNotMatch(publicCode, /milo|workspace|SERVICE_TOKEN|purpose|expires/i);

  const box = await encryptHumanHandoffSecret(publicCode, 'known-secret-specimen');
  const parsed = parseHumanHandoffBox(box);
  assert.equal(parsed.publicKey, keys.publicKey);
  assert.doesNotMatch(box, /known-secret-specimen/);
  assert.deepEqual(decryptHumanHandoffSecret(keys.privateKey, box), {
    v: 1,
    value: 'known-secret-specimen',
  });
  const wrongKeys = createHandoffKeyPair();
  assert.throws(
    () => decryptHumanHandoffSecret(wrongKeys.privateKey, box),
    /could not be decrypted|tampered/,
  );
  const first = parsed.ciphertext.at(0);
  assert.ok(first);
  const tampered = encodeHumanHandoffBox({
    ...parsed,
    ciphertext: `${first === 'A' ? 'B' : 'A'}${parsed.ciphertext.slice(1)}`,
  });
  assert.throws(
    () => decryptHumanHandoffSecret(keys.privateKey, tampered),
    /could not be decrypted|tampered|Invalid/,
  );
  assert.equal(
    await humanHandoffKeyId(keys.publicKey),
    await humanHandoffKeyId(parsed.publicKey),
  );
});

test('pending human handoff lock admits exactly one accept', async () => {
  const animaHome = await mkdtemp(join(tmpdir(), 'anima-human-handoff-lock-'));
  try {
    const keys = createHandoffKeyPair();
    const pending = new HumanSecretHandoffPendingStore('milo', animaHome);
    await pending.create(keys.publicKey, keys.privateKey, future());
    const box = await encryptHumanHandoffSecret(
      encodeHumanHandoffPublicKey(keys.publicKey),
      'secret',
    );
    let writes = 0;
    const accept = () =>
      pending.consume(box, async () => {
        writes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const results = await Promise.allSettled([accept(), accept()]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === 'rejected').length,
      1,
    );
    assert.equal(writes, 1);
  } finally {
    await rm(animaHome, { force: true, recursive: true });
  }
});

test('secret handoff binds the sender and every canonical request field through the digest', async () => {
  const keys = createHandoffKeyPair();
  const request = createHandoffRequest({
    recipientAgentId: 'milo',
    targetKey: 'SERVICE_TOKEN',
    purpose: 'Original purpose',
    sender: { kind: 'agent', agentId: 'nora' },
    expiresAt: future(),
    publicKey: keys.publicKey,
  });
  await assert.rejects(
    () =>
      encryptHandoffSecret(request, {
        sender: { kind: 'agent', agentId: 'aria' },
        value: 'secret',
      }),
    /expects sender nora/,
  );

  const changedPurpose = { ...request, purpose: 'Altered purpose' };
  const box = await encryptHandoffSecret(changedPurpose, {
    sender: { kind: 'agent', agentId: 'nora' },
    value: 'secret',
  });
  await assert.rejects(
    () => decryptHandoffSecret(request, keys.privateKey, box),
    /request digest does not match/,
  );
});

test('human handoff binds displayed Slack workspace metadata through the request digest', async () => {
  const keys = createHandoffKeyPair();
  const request = createHandoffRequest({
    recipientAgentId: 'milo',
    targetKey: 'SERVICE_TOKEN',
    purpose: 'Human workspace binding',
    sender: {
      kind: 'human',
      workspaceId: 'T01234567',
      workspaceName: 'Anima Team',
    },
    expiresAt: future(),
    publicKey: keys.publicKey,
  });
  assert.deepEqual(parseHandoffRequest(encodeHandoffRequest(request)), request);

  const changedWorkspace = {
    ...request,
    workspaceName: 'Impostor Workspace',
  };
  const box = await encryptHandoffSecret(changedWorkspace, {
    sender: { kind: 'human' },
    value: 'secret',
  });
  await assert.rejects(
    () => decryptHandoffSecret(request, keys.privateKey, box),
    /request digest does not match/,
  );
});

test('secret handoff rejects tampering, expiration, and non-canonical request fields', async () => {
  const keys = createHandoffKeyPair();
  const request = createHandoffRequest({
    recipientAgentId: 'milo',
    targetKey: 'SERVICE_TOKEN',
    purpose: 'Verify failure paths',
    sender: { kind: 'any-workspace-agent' },
    expiresAt: future(),
    publicKey: keys.publicKey,
  });
  const box = await encryptHandoffSecret(request, {
    sender: { kind: 'agent', agentId: 'nora' },
    value: 'secret',
  });
  const parsed = parseHandoffBox(box);
  const last = parsed.ciphertext.at(-1);
  assert.ok(last);
  const replacement = last === 'A' ? 'B' : 'A';
  const tamperedBox = {
    ...parsed,
    ciphertext: `${parsed.ciphertext.slice(0, -1)}${replacement}`,
  };
  const encodedTamperedBox = `asec_box_v1_${Buffer.from(JSON.stringify(tamperedBox)).toString('base64url')}`;
  await assert.rejects(
    () => decryptHandoffSecret(request, keys.privateKey, encodedTamperedBox),
    /could not be decrypted|Invalid|canonically encoded/,
  );

  const expired = createHandoffRequest({
    recipientAgentId: 'milo',
    targetKey: 'SERVICE_TOKEN',
    purpose: 'Expired request',
    sender: {
      kind: 'human',
      workspaceId: 'T-DEMO',
      workspaceName: 'Demo Workspace',
    },
    now: new Date(Date.now() - 2 * 60 * 60 * 1000),
    expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    publicKey: keys.publicKey,
  });
  await assert.rejects(
    () =>
      encryptHandoffSecret(expired, {
        sender: { kind: 'human' },
        value: 'secret',
      }),
    /expired/,
  );

  const json = JSON.parse(
    Buffer.from(
      encodeHandoffRequest(request).slice('asec_req_v1_'.length),
      'base64url',
    ).toString('utf8'),
  ) as Record<string, unknown>;
  json.extra = true;
  const unknownFieldCode = `asec_req_v1_${Buffer.from(JSON.stringify(json)).toString('base64url')}`;
  assert.throws(
    () => parseHandoffRequest(unknownFieldCode),
    /fields are invalid/,
  );
});

test('maximum secret stays below the committed Slack payload boundary', async () => {
  const keys = createHandoffKeyPair();
  const request = createHandoffRequest({
    recipientAgentId: 'milo',
    targetKey: 'SERVICE_TOKEN',
    purpose: 'Exercise the maximum supported secret size',
    sender: {
      kind: 'human',
      workspaceId: 'T-DEMO',
      workspaceName: 'Demo Workspace',
    },
    expiresAt: future(),
    publicKey: keys.publicKey,
  });
  const box = await encryptHandoffSecret(request, {
    sender: { kind: 'human' },
    value: 'x'.repeat(MAX_HANDOFF_SECRET_BYTES),
  });
  const slackBlock = formatHandoffBoxForSlack(box);
  assert.ok(
    slackBlock.length < 12_000,
    `${slackBlock.length} must stay below 12000`,
  );
  assert.equal(
    (await decryptHandoffSecret(request, keys.privateKey, slackBlock)).value
      .length,
    4096,
  );
  await assert.rejects(
    () =>
      encryptHandoffSecret(request, {
        sender: { kind: 'human' },
        value: 'x'.repeat(MAX_HANDOFF_SECRET_BYTES + 1),
      }),
    /exceeds 4096 UTF-8 bytes/,
  );
});

test('maximum generic human secret stays below the Slack payload boundary', async () => {
  const keys = createHandoffKeyPair();
  const box = await encryptHumanHandoffSecret(
    encodeHumanHandoffPublicKey(keys.publicKey),
    'x'.repeat(MAX_HANDOFF_SECRET_BYTES),
  );
  const slackBlock = formatHumanHandoffBoxForSlack(box);
  assert.ok(slackBlock.length < 12_000, `${slackBlock.length} must stay below 12000`);
  assert.equal(decryptHumanHandoffSecret(keys.privateKey, slackBlock).value.length, 4096);
  await assert.rejects(
    () =>
      encryptHumanHandoffSecret(
        encodeHumanHandoffPublicKey(keys.publicKey),
        'x'.repeat(MAX_HANDOFF_SECRET_BYTES + 1),
      ),
    /exceeds 4096 UTF-8 bytes/,
  );
});

test('pending handoff state is private, single-use, and writes directly to encrypted env', async () => {
  const animaHome = await mkdtemp(join(tmpdir(), 'anima-handoff-store-'));
  try {
    const keys = createHandoffKeyPair();
    const request = createHandoffRequest({
      recipientAgentId: 'milo',
      targetKey: 'SERVICE_TOKEN',
      purpose: 'Exercise pending state',
      sender: { kind: 'agent', agentId: 'nora' },
      expiresAt: future(),
      publicKey: keys.publicKey,
    });
    const pending = new SecretHandoffPendingStore('milo', animaHome);
    await pending.create(request, keys.privateKey);
    const pendingPath = pending.pendingPath(request.requestId);
    assert.equal((await stat(dirname(pendingPath))).mode & 0o777, 0o700);
    assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(
      await readFile(pendingPath, 'utf8'),
      /known-secret-specimen/,
    );

    const box = await encryptHandoffSecret(request, {
      sender: { kind: 'agent', agentId: 'nora' },
      value: 'known-secret-specimen',
    });
    const envStore = new AgentEnvStore('milo', animaHome);
    await pending.consume(request.requestId, box, async (payload) => {
      await envStore.set(payload.targetKey, payload.value, 'secret', {
        replace: false,
      });
    });
    assert.equal(
      (await envStore.load()).secret.SERVICE_TOKEN,
      'known-secret-specimen',
    );
    await assert.rejects(() => stat(pendingPath), /ENOENT/);
    await assert.rejects(
      () => pending.consume(request.requestId, box, async () => undefined),
      /not found/,
    );
  } finally {
    await rm(animaHome, { force: true, recursive: true });
  }
});

test('pending human handoff is private, single-use, and chooses its env key on accept', async () => {
  const animaHome = await mkdtemp(join(tmpdir(), 'anima-human-handoff-store-'));
  try {
    const keys = createHandoffKeyPair();
    const pending = new HumanSecretHandoffPendingStore('milo', animaHome);
    const wrongKeys = createHandoffKeyPair();
    await assert.rejects(
      () => pending.create(keys.publicKey, wrongKeys.privateKey, future()),
      /key pair does not match/,
    );
    const id = await pending.create(keys.publicKey, keys.privateKey, future());
    const path = pending.pendingPath(id);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path, 'utf8'), /known-secret-specimen/);

    const box = await encryptHumanHandoffSecret(
      encodeHumanHandoffPublicKey(keys.publicKey),
      'known-secret-specimen',
    );
    const envStore = new AgentEnvStore('milo', animaHome);
    await pending.consume(box, async (payload) => {
      await envStore.set('CHOSEN_AT_ACCEPT', payload.value, 'secret', {
        replace: false,
      });
    });
    assert.equal((await envStore.load()).secret.CHOSEN_AT_ACCEPT, 'known-secret-specimen');
    await assert.rejects(() => stat(path), /ENOENT/);
    await assert.rejects(() => pending.consume(box, async () => undefined), /not found/);
  } finally {
    await rm(animaHome, { force: true, recursive: true });
  }
});

test('pending handoff lock admits one concurrent accept and retains uncertain outcomes', async () => {
  const animaHome = await mkdtemp(join(tmpdir(), 'anima-handoff-concurrent-'));
  try {
    const keys = createHandoffKeyPair();
    const request = createHandoffRequest({
      recipientAgentId: 'milo',
      targetKey: 'SERVICE_TOKEN',
      purpose: 'Exercise concurrent acceptance',
      sender: { kind: 'agent', agentId: 'nora' },
      expiresAt: future(),
      publicKey: keys.publicKey,
    });
    const pending = new SecretHandoffPendingStore('milo', animaHome);
    await pending.create(request, keys.privateKey);
    const box = await encryptHandoffSecret(request, {
      sender: { kind: 'agent', agentId: 'nora' },
      value: 'secret',
    });
    let writes = 0;
    const accept = () =>
      pending.consume(request.requestId, box, async () => {
        writes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    const results = await Promise.allSettled([accept(), accept()]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === 'rejected').length,
      1,
    );
    assert.equal(writes, 1);

    const secondKeys = createHandoffKeyPair();
    const uncertainRequest = createHandoffRequest({
      recipientAgentId: 'milo',
      targetKey: 'SECOND_TOKEN',
      purpose: 'Exercise uncertain result',
      sender: {
        kind: 'human',
        workspaceId: 'T-DEMO',
        workspaceName: 'Demo Workspace',
      },
      expiresAt: future(),
      publicKey: secondKeys.publicKey,
    });
    await pending.create(uncertainRequest, secondKeys.privateKey);
    const uncertainBox = await encryptHandoffSecret(uncertainRequest, {
      sender: { kind: 'human' },
      value: 'secret',
    });
    await assert.rejects(
      () =>
        pending.consume(uncertainRequest.requestId, uncertainBox, async () => {
          throw new Error('write failed');
        }),
      /write failed/,
    );
    await assert.rejects(
      () =>
        pending.consume(
          uncertainRequest.requestId,
          uncertainBox,
          async () => undefined,
        ),
      /uncertain prior outcome/,
    );
    await pending.resetRejectedWrite(uncertainRequest.requestId);
    await pending.consume(
      uncertainRequest.requestId,
      uncertainBox,
      async () => undefined,
    );
  } finally {
    await rm(animaHome, { force: true, recursive: true });
  }
});

test('env handoff write lock rejects racing requests and never recreates a deleted home', async () => {
  const animaHome = await mkdtemp(join(tmpdir(), 'anima-handoff-env-lock-'));
  const envStore = new AgentEnvStore('milo', animaHome);
  const writes = await Promise.allSettled([
    envStore.set('SERVICE_TOKEN', 'first', 'secret', { replace: false }),
    envStore.set('SERVICE_TOKEN', 'second', 'secret', { replace: false }),
  ]);
  assert.equal(
    writes.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    writes.filter((result) => result.status === 'rejected').length,
    1,
  );
  const stored = (await envStore.load()).secret.SERVICE_TOKEN;
  assert.ok(stored === 'first' || stored === 'second');

  await rm(animaHome, { force: true, recursive: true });
  await assert.rejects(
    () => envStore.set('ANOTHER_TOKEN', 'secret', 'secret', { replace: false }),
    /write root .* does not exist/,
  );
  await assert.rejects(() => stat(animaHome), /ENOENT/);
});
