import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { withAnimaHome } from './anima-home.js';
import { writeAgentConfigs } from './helpers/harness.js';
import { createWebServer } from '../web/app.js';

// The default login service is a process singleton; each test uses its own
// provider command so a state written by one test cannot leak into the next.

async function withServer(run: (base: string, stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'anima-web-api-provider-login-'));
  const previousMachineWrites = process.env.ANIMA_ALLOW_MACHINE_WRITES;
  process.env.ANIMA_ALLOW_MACHINE_WRITES = '1';
  await writeAgentConfigs(stateDir);
  try {
    await withAnimaHome(stateDir, async () => {
      const server = await createWebServer();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP address');
        await run(`http://127.0.0.1:${address.port}`, stateDir);
      } finally {
        server.close();
      }
    });
  } finally {
    if (previousMachineWrites === undefined) delete process.env.ANIMA_ALLOW_MACHINE_WRITES;
    else process.env.ANIMA_ALLOW_MACHINE_WRITES = previousMachineWrites;
    await rm(stateDir, { force: true, recursive: true });
  }
}

interface LoginRow {
  command: string;
  detail?: string;
  operation: { code?: string; error?: string; mode?: string; status: string; url?: string };
  provider: string;
  state: string;
}

async function codexRow(base: string): Promise<LoginRow | undefined> {
  const response = await fetch(`${base}/api/provider-login`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { providers: LoginRow[] };
  return body.providers.find((row) => row.provider === 'codex-cli');
}

async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('web API runs a device sign-in through the configured provider command', async () => {
  await withServer(async (base, stateDir) => {
    const marker = join(stateDir, 'signed-in');
    const fake = join(stateDir, 'mcodex');
    await writeFile(
      fake,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        `const marker = ${JSON.stringify(marker)};`,
        'const args = process.argv.slice(2);',
        "if (args.join(' ') === 'login status') {",
        "  if (fs.existsSync(marker)) { console.log('Logged in using ChatGPT'); process.exit(0); }",
        "  console.log('Not logged in'); process.exit(1);",
        '}',
        "if (args.join(' ') === 'login --device-auth') {",
        "  console.log('   https://example.test/device');",
        "  console.log('   WXYZ-12345');",
        "  setTimeout(() => { fs.writeFileSync(marker, 'ok'); process.exit(0); }, 400);",
        '  setInterval(() => {}, 1000);',
        '}',
        '',
      ].join('\n'),
    );
    await chmod(fake, 0o755);
    const configured = await fetch(`${base}/api/provider-runtime-commands`, {
      body: JSON.stringify({ args: [], command: fake, provider: 'codex-cli' }),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });
    assert.equal(configured.status, 200);

    const before = await codexRow(base);
    assert.equal(before?.command, fake);
    assert.equal(before?.state, 'signed_out');
    assert.equal(before?.operation.status, 'idle');

    const badProvider = await fetch(`${base}/api/provider-login/not-a-provider`, {
      body: JSON.stringify({ mode: 'device' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(badProvider.status, 400);
    const badMode = await fetch(`${base}/api/provider-login/codex-cli`, {
      body: JSON.stringify({ mode: 'sms' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(badMode.status, 400);
    const unsupported = await fetch(`${base}/api/provider-login/claude-code`, {
      body: JSON.stringify({ mode: 'device' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(unsupported.status, 404);

    const started = await fetch(`${base}/api/provider-login/codex-cli`, {
      body: JSON.stringify({ mode: 'device' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(started.status, 200);
    const startedRow = ((await started.json()) as { providers: LoginRow[] }).providers.find(
      (row) => row.provider === 'codex-cli',
    );
    assert.equal(startedRow?.operation.status, 'running');
    assert.equal(startedRow?.operation.mode, 'device');

    const again = await fetch(`${base}/api/provider-login/codex-cli`, {
      body: JSON.stringify({ mode: 'device' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(again.status, 409);

    await until(async () => (await codexRow(base))?.operation.code === 'WXYZ-12345', 'the device code');
    assert.equal((await codexRow(base))?.operation.url, 'https://example.test/device');

    await until(async () => (await codexRow(base))?.operation.status === 'succeeded', 'the sign-in');
    const after = await codexRow(base);
    assert.equal(after?.state, 'signed_in');
    assert.equal(after?.detail, 'Logged in using ChatGPT');

    const noRun = await fetch(`${base}/api/provider-login/codex-cli`, { method: 'DELETE' });
    assert.equal(noRun.status, 409);
  });
});

test('web API cancels a running browser sign-in', async () => {
  await withServer(async (base, stateDir) => {
    const fake = join(stateDir, 'mcodex');
    await writeFile(
      fake,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        "if (args.join(' ') === 'login status') { console.log('Not logged in'); process.exit(1); }",
        "console.log('https://example.test/authorize');",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    await chmod(fake, 0o755);
    const configured = await fetch(`${base}/api/provider-runtime-commands`, {
      body: JSON.stringify({ args: [], command: fake, provider: 'codex-cli' }),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });
    assert.equal(configured.status, 200);

    // Read-only refusal of the POST/DELETE pair is covered by the governed-route
    // inventory test (read-only-runtime.test.ts); the mode is fixed at server boot.
    const started = await fetch(`${base}/api/provider-login/codex-cli`, {
      body: JSON.stringify({ mode: 'browser' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(started.status, 200);
    await until(
      async () => (await codexRow(base))?.operation.url === 'https://example.test/authorize',
      'the browser link',
    );
    const cancelled = await fetch(`${base}/api/provider-login/codex-cli`, { method: 'DELETE' });
    assert.equal(cancelled.status, 200);
    await until(async () => (await codexRow(base))?.operation.status === 'cancelled', 'the cancel');
    assert.equal((await codexRow(base))?.operation.mode, 'browser');
  });
});
