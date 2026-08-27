import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseProviderLoginOutput,
  ProviderLoginError,
  ProviderLoginService,
  stripAnsi,
} from '../providers/login.service.js';

const ESC = String.fromCharCode(27);

test('provider login parser reads the codex device-auth transcript', () => {
  const lines = [
    '',
    `Welcome to Codex [v${ESC}[90m0.149.1${ESC}[0m]`,
    'Follow these steps to sign in with ChatGPT using device code authorization:',
    '',
    '1. Open this link in your browser and sign in to your account',
    `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`,
    '',
    `2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m`,
    `   ${ESC}[94mQWER-TY123${ESC}[0m`,
  ];
  assert.deepEqual(parseProviderLoginOutput(lines), {
    code: 'QWER-TY123',
    url: 'https://auth.openai.com/codex/device',
  });
});

test('provider login parser skips the local callback address in the browser transcript', () => {
  const lines = [
    'Starting local login server on http://localhost:1455.',
    'If your browser did not open, navigate to this URL to authenticate:',
    '',
    'https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz',
    '',
    'On a remote or headless machine? Use `codex login --device-auth` instead.',
  ];
  assert.deepEqual(parseProviderLoginOutput(lines), {
    url: 'https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz',
  });
  assert.deepEqual(parseProviderLoginOutput(['Starting local login server on http://localhost:1455.']), {});
  assert.equal(stripAnsi(`${ESC}[1mbold${ESC}[0m`), 'bold');
});

async function writeFakeCli(dir: string, body: string): Promise<string> {
  const path = join(dir, 'fake-codex');
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('provider login service runs the configured command and reports the code, then the sign-in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-provider-login-'));
  try {
    const marker = join(dir, 'signed-in');
    const fake = await writeFakeCli(
      dir,
      [
        "const fs = require('node:fs');",
        `const marker = ${JSON.stringify(marker)};`,
        'const args = process.argv.slice(2);',
        "if (args.join(' ') === 'login status') {",
        "  if (fs.existsSync(marker)) { console.log('Logged in using ChatGPT'); process.exit(0); }",
        "  console.log('Not logged in'); process.exit(1);",
        '}',
        "if (args.join(' ') === 'login --device-auth') {",
        "  console.log('1. Open this link in your browser');",
        "  console.log('   https://example.test/device');",
        "  console.log('2. Enter this one-time code');",
        "  console.log('   ABCD-EFGH1');",
        "  setTimeout(() => { fs.writeFileSync(marker, 'ok'); process.exit(0); }, 300);",
        '  setInterval(() => {}, 1000);',
        '}',
      ].join('\n'),
    );
    const service = new ProviderLoginService({
      env: process.env,
      settings: { getProviderRuntimeCommands: async () => ({ 'codex-cli': fake }) },
    });

    const before = await service.status();
    const codex = before.providers.find((row) => row.provider === 'codex-cli');
    assert.equal(codex?.state, 'signed_out');
    assert.equal(codex?.detail, 'Not logged in');
    assert.equal(codex?.command, fake);
    assert.equal(codex?.operation.status, 'idle');
    assert.equal(before.providers.find((row) => row.provider === 'claude-code')?.state, 'unsupported');

    await service.start('codex-cli', 'device');
    await assert.rejects(service.start('codex-cli', 'device'), (error: unknown) => {
      assert.ok(error instanceof ProviderLoginError);
      assert.equal(error.statusCode, 409);
      return true;
    });
    await until(async () => {
      const row = (await service.status()).providers.find((r) => r.provider === 'codex-cli');
      return row?.operation.code === 'ABCD-EFGH1';
    }, 'the device code');
    const running = (await service.status()).providers.find((row) => row.provider === 'codex-cli');
    assert.equal(running?.operation.status, 'running');
    assert.equal(running?.operation.mode, 'device');
    assert.equal(running?.operation.url, 'https://example.test/device');
    assert.ok(running?.operation.expiresAt);

    await until(async () => {
      const row = (await service.status()).providers.find((r) => r.provider === 'codex-cli');
      return row?.operation.status === 'succeeded';
    }, 'the sign-in to finish');
    const after = (await service.status()).providers.find((row) => row.provider === 'codex-cli');
    assert.equal(after?.state, 'signed_in', 'status cache is dropped when the login finishes');
    assert.equal(after?.detail, 'Logged in using ChatGPT');
    assert.ok(after?.operation.completedAt);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('provider login service cancels a running sign-in and reports a failed one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anima-provider-login-cancel-'));
  try {
    const fake = await writeFakeCli(
      dir,
      [
        'const args = process.argv.slice(2);',
        "if (args.join(' ') === 'login status') { console.log('Not logged in'); process.exit(1); }",
        "if (args.includes('--device-auth')) { console.log('https://example.test/device'); setInterval(() => {}, 1000); }",
        "else { console.error('error: browser login is disabled for this account'); process.exit(2); }",
      ].join('\n'),
    );
    const service = new ProviderLoginService({
      env: process.env,
      settings: { getProviderRuntimeCommands: async () => ({ 'codex-cli': fake }) },
    });
    await assert.rejects(service.cancel('codex-cli'), (error: unknown) => {
      assert.ok(error instanceof ProviderLoginError);
      assert.equal(error.statusCode, 409);
      return true;
    });
    await assert.rejects(service.start('claude-code', 'device'), (error: unknown) => {
      assert.ok(error instanceof ProviderLoginError);
      assert.equal(error.statusCode, 404);
      return true;
    });

    await service.start('codex-cli', 'device');
    await until(async () => {
      const row = (await service.status()).providers.find((r) => r.provider === 'codex-cli');
      return row?.operation.url === 'https://example.test/device';
    }, 'the sign-in link');
    await service.cancel('codex-cli');
    await until(async () => {
      const row = (await service.status()).providers.find((r) => r.provider === 'codex-cli');
      return row?.operation.status === 'cancelled';
    }, 'the cancel');

    await service.start('codex-cli', 'browser');
    await until(async () => {
      const row = (await service.status()).providers.find((r) => r.provider === 'codex-cli');
      return row?.operation.status === 'failed';
    }, 'the failure');
    const failed = (await service.status()).providers.find((row) => row.provider === 'codex-cli');
    assert.equal(failed?.operation.mode, 'browser');
    assert.equal(failed?.operation.error, 'error: browser login is disabled for this account');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
