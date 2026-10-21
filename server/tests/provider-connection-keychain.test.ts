import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchClaudeConnectionUsage } from '../provider-usage/connection.js';

// In the runtime tier so the macOS CI job runs it; the fast tier runs on
// Linux, where Claude never asks the Keychain. A script on PATH stands in for
// `security`, so the real Keychain is never read.
test(
  'Claude distinguishes denied Keychain reads from verified absence',
  { skip: process.platform !== 'darwin' ? 'Keychain lookup is macOS only' : false },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'provider-connection-keychain-'));
    t.after(() => rm(home, { force: true, recursive: true }));
    await mkdir(join(home, '.claude'));
    const bin = join(home, 'bin');
    await mkdir(bin);
    const original = process.env.PATH;
    process.env.PATH = `${bin}:${original ?? ''}`;
    t.after(() => {
      process.env.PATH = original;
    });
    const fake = async (exit: number) =>
      writeFile(join(bin, 'security'), `#!/bin/sh\nprintf called > "$0.called"\nexit ${exit}\n`, { mode: 0o755 });

    await fake(36);
    const denied = await fetchClaudeConnectionUsage({ home, env: {} });
    assert.equal(await readFile(join(bin, 'security.called'), 'utf8'), 'called');
    assert.equal(denied.connection?.status, 'unknown');
    assert.equal(denied.error?.type, 'unknown');

    await fake(44);
    const absent = await fetchClaudeConnectionUsage({ home, env: {} });
    assert.equal(absent.connection?.status, 'not-configured');
    assert.equal(absent.error?.type, 'not_configured');

    await writeFile(join(home, '.claude', '.credentials.json'), '{invalid');
    const malformed = await fetchClaudeConnectionUsage({ home, env: {} });
    assert.equal(malformed.connection?.status, 'unknown', 'bad file plus absent Keychain is still unknown');
  },
);
