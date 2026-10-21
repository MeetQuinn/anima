import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { runAnimactlWith, writeFakeServiceManager } from './helpers/service-manager.js';

// Fast tier on purpose: CI runs that tier on Linux, which covers the systemd branch.
test(
  'installed services run from the package root, not the directory animactl was run from',
  { skip: process.platform !== 'darwin' && process.platform !== 'linux' ? 'launchd or systemd only' : false },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'anima-service-cwd-'));
    try {
      const darwin = process.platform === 'darwin';
      const fake = await writeFakeServiceManager(tempDir, darwin ? 'launchctl' : 'systemctl');
      const elsewhere = join(tempDir, 'elsewhere');
      await mkdir(elsewhere);

      const installed = await runAnimactlWith(['services', 'install', '--only', 'agent'], fake.env, { cwd: elsewhere });
      assert.equal(installed.status, 0, installed.stderr || installed.stdout);

      const packageRoot = resolve('.');
      const unit = darwin
        ? await readFile(join(fake.home, 'Library', 'LaunchAgents', 'ai.meetquinn.anima.agent.plist'), 'utf8')
        : await readFile(join(fake.home, '.config', 'systemd', 'user', 'ai.meetquinn.anima.agent.service'), 'utf8');
      const workingDirectory = darwin
        ? /<key>WorkingDirectory<\/key>\n<string>([^<]*)<\/string>/.exec(unit)?.[1]
        : /^WorkingDirectory=(.*)$/m.exec(unit)?.[1]?.replaceAll('\\x20', ' ');
      assert.equal(workingDirectory, packageRoot);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  },
);
