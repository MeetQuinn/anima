import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  MAX_HANDOFF_SECRET_BYTES,
  createHandoffKeyPair,
  decryptSealedHandoffSecret,
  encodeSealedHandoffBox,
  encodeSealedHandoffPublicKey,
  encryptSealedHandoffSecret,
  formatSealedHandoffBoxForSlack,
  sealedHandoffKeyId,
  parseSealedHandoffBox,
} from '../../shared/secret-handoff.js';
import { AgentEnvStore } from '../env/agent-env-store.js';
import { SealedSecretHandoffPendingStore } from '../env/sealed-secret-handoff-store.js';

const future = () => new Date(Date.now() + 60 * 60 * 1000);

test('sealed handoff code contains only a public key and its generic box round trips', async () => {
  const keys = createHandoffKeyPair();
  const publicCode = encodeSealedHandoffPublicKey(keys.publicKey);
  assert.equal(publicCode, `asec_key_v1_${keys.publicKey}`);
  assert.doesNotMatch(publicCode, /milo|workspace|SERVICE_TOKEN|purpose|expires/i);

  const box = await encryptSealedHandoffSecret(publicCode, 'known-secret-specimen');
  const parsed = parseSealedHandoffBox(box);
  assert.equal(parsed.publicKey, keys.publicKey);
  assert.doesNotMatch(box, /known-secret-specimen/);
  assert.deepEqual(decryptSealedHandoffSecret(keys.privateKey, box), {
    v: 1,
    value: 'known-secret-specimen',
  });
  const wrongKeys = createHandoffKeyPair();
  assert.throws(
    () => decryptSealedHandoffSecret(wrongKeys.privateKey, box),
    /could not be decrypted|tampered/,
  );
  const first = parsed.ciphertext.at(0);
  assert.ok(first);
  const tampered = encodeSealedHandoffBox({
    ...parsed,
    ciphertext: `${first === 'A' ? 'B' : 'A'}${parsed.ciphertext.slice(1)}`,
  });
  assert.throws(
    () => decryptSealedHandoffSecret(keys.privateKey, tampered),
    /could not be decrypted|tampered|Invalid/,
  );
  assert.equal(
    await sealedHandoffKeyId(keys.publicKey),
    await sealedHandoffKeyId(parsed.publicKey),
  );
});

test('pending sealed handoff lock admits exactly one accept and retains uncertain outcomes', async () => {
  const animaHome = await mkdtemp(join(tmpdir(), 'anima-sealed-handoff-lock-'));
  try {
    const keys = createHandoffKeyPair();
    const pending = new SealedSecretHandoffPendingStore('milo', animaHome);
    await pending.create(keys.publicKey, keys.privateKey, future());
    const box = await encryptSealedHandoffSecret(
      encodeSealedHandoffPublicKey(keys.publicKey),
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

    const secondKeys = createHandoffKeyPair();
    await pending.create(secondKeys.publicKey, secondKeys.privateKey, future());
    const uncertainBox = await encryptSealedHandoffSecret(
      encodeSealedHandoffPublicKey(secondKeys.publicKey),
      'secret',
    );
    await assert.rejects(
      () =>
        pending.consume(uncertainBox, async () => {
          throw new Error('write failed');
        }),
      /write failed/,
    );
    await assert.rejects(
      () => pending.consume(uncertainBox, async () => undefined),
      /uncertain prior outcome/,
    );
    await pending.resetRejectedWrite(uncertainBox);
    await pending.consume(uncertainBox, async () => undefined);
  } finally {
    await rm(animaHome, { force: true, recursive: true });
  }
});

test('sealed handoff rejects an expired key and non-canonical boxes', async () => {
  const animaHome = await mkdtemp(join(tmpdir(), 'anima-sealed-handoff-reject-'));
  try {
    const keys = createHandoffKeyPair();
    const pending = new SealedSecretHandoffPendingStore('milo', animaHome);
    const id = await pending.create(
      keys.publicKey,
      keys.privateKey,
      new Date(Date.now() - 60 * 60 * 1000),
      new Date(Date.now() - 2 * 60 * 60 * 1000),
    );
    const box = await encryptSealedHandoffSecret(
      encodeSealedHandoffPublicKey(keys.publicKey),
      'secret',
    );
    let writes = 0;
    await assert.rejects(
      () =>
        pending.consume(box, async () => {
          writes += 1;
        }),
      /has expired/,
    );
    assert.equal(writes, 0);
    await assert.rejects(() => stat(pending.pendingPath(id)), /ENOENT/);

    const parsed = parseSealedHandoffBox(box);
    const encode = (value: Record<string, unknown>) =>
      `asec_sealed_v1_${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    assert.throws(
      () => parseSealedHandoffBox(encode({ ...parsed, extra: true })),
      /fields are invalid/,
    );
    assert.throws(
      () =>
        parseSealedHandoffBox(
          encode({ ciphertext: parsed.ciphertext, publicKey: parsed.publicKey, v: 1 }),
        ),
      /not canonically encoded/,
    );
  } finally {
    await rm(animaHome, { force: true, recursive: true });
  }
});

test('maximum generic sealed secret stays below the Slack payload boundary', async () => {
  const keys = createHandoffKeyPair();
  const box = await encryptSealedHandoffSecret(
    encodeSealedHandoffPublicKey(keys.publicKey),
    'x'.repeat(MAX_HANDOFF_SECRET_BYTES),
  );
  const slackBlock = formatSealedHandoffBoxForSlack(box);
  assert.ok(slackBlock.length < 12_000, `${slackBlock.length} must stay below 12000`);
  assert.equal(decryptSealedHandoffSecret(keys.privateKey, slackBlock).value.length, 4096);
  await assert.rejects(
    () =>
      encryptSealedHandoffSecret(
        encodeSealedHandoffPublicKey(keys.publicKey),
        'x'.repeat(MAX_HANDOFF_SECRET_BYTES + 1),
      ),
    /exceeds 4096 UTF-8 bytes/,
  );
});

test('pending sealed handoff is private, single-use, and chooses its env key on accept', async () => {
  const animaHome = await mkdtemp(join(tmpdir(), 'anima-sealed-handoff-store-'));
  try {
    const keys = createHandoffKeyPair();
    const pending = new SealedSecretHandoffPendingStore('milo', animaHome);
    const wrongKeys = createHandoffKeyPair();
    await assert.rejects(
      () => pending.create(keys.publicKey, wrongKeys.privateKey, future()),
      /key pair does not match/,
    );
    const id = await pending.create(keys.publicKey, keys.privateKey, future());
    const path = pending.pendingPath(id);
    assert.equal(
      dirname(path),
      join(animaHome, 'agents', 'milo', 'env', 'handoff', 'sealed'),
    );
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path, 'utf8'), /known-secret-specimen/);

    const box = await encryptSealedHandoffSecret(
      encodeSealedHandoffPublicKey(keys.publicKey),
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
