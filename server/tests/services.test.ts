import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  launchdActionInvocation,
  buildLaunchdPlist,
  launchdInstallActions,
  launchdLabel,
  launchdStartActions,
  launchdStopActions,
  parseLaunchdRuntime,
} from '../services/launchd.js';
import {
  buildSystemdUnit,
  parseSystemdRuntime,
  systemdActionInvocation,
  systemdInstallActions,
  systemdServiceName,
  systemdStartActions,
  systemdStopActions,
  systemdUninstallActions,
} from '../services/systemd.js';
import { buildServiceEnvironment, buildServicePath, cleanServiceEnv } from '../services/env.js';
import { stopPidFallbackService } from '../services/supervisor.js';

const animactl = resolve('dist/server/cli/animactl.js');

test('animactl --version prints the package version', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version?: unknown };
  const expectedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';

  const version = await runAnimactl(['--version']);

  assert.equal(version.status, 0, version.stderr || version.stdout);
  assert.equal(version.stdout.trim(), expectedVersion);
});

test('cleanServiceEnv strips runtime item context before spawning services', () => {
  const env = cleanServiceEnv({
    ANIMA_AGENT_ID: 'milo',
    ANIMA_HOME: '/tmp/source-home',
    ANIMA_INBOX_ITEM_ID: 'item_123',
    ANIMA_RUNTIME_HOME: '/tmp/source-home',
    ANIMA_SLACK_BOT_TOKEN: 'xoxb-secret',
    FEISHU_APP_SECRET: 'feishu-secret',
    FEISHU_TENANT_ACCESS_TOKEN: 't-tenant',
    PATH: '/usr/bin',
    SAFE_VALUE: 'kept',
    SLACK_BOT_TOKEN: 'xoxb-secret',
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.SAFE_VALUE, 'kept');
  assert.equal(env.ANIMA_AGENT_ID, undefined);
  assert.equal(env.ANIMA_HOME, undefined);
  assert.equal(env.ANIMA_INBOX_ITEM_ID, undefined);
  assert.equal(env.ANIMA_RUNTIME_HOME, undefined);
  assert.equal(env.ANIMA_SLACK_BOT_TOKEN, undefined);
  assert.equal(env.FEISHU_APP_SECRET, undefined);
  assert.equal(env.FEISHU_TENANT_ACCESS_TOKEN, undefined);
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
});

test('service environment builds a durable service PATH instead of copying caller PATH', () => {
  const env = buildServiceEnvironment({
    animaHome: '/Users/test/.anima',
    baseEnv: {
      ANIMA_AGENT_ID: 'milo',
      ANIMA_INBOX_ITEM_ID: 'item_123',
      HOME: '/Users/test',
      PATH: '/tmp/codex-temp:/usr/bin',
      SHELL: '/bin/zsh',
      SLACK_BOT_TOKEN: 'xoxb-secret',
      USER: 'test',
    },
    homeDir: '/Users/test',
    nodePath: '/opt/homebrew/opt/node/bin/node',
    platform: 'darwin',
  });

  assert.equal(env.ANIMA_HOME, '/Users/test/.anima');
  assert.equal(env.HOME, '/Users/test');
  assert.equal(env.SHELL, '/bin/zsh');
  assert.equal(env.USER, 'test');
  assert.equal(env.ANIMA_AGENT_ID, undefined);
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
  const path = env.PATH ?? '';
  assert.match(path, /^\/opt\/homebrew\/opt\/node\/bin:/);
  assert.match(path, /\/Users\/test\/\.local\/bin/);
  assert.match(path, /\/Users\/test\/\.kimi-code\/bin/);
  assert.match(path, /\/opt\/homebrew\/bin/);
  assert.match(path, /\/usr\/sbin/);
  assert.doesNotMatch(path, /codex-temp/);
});

test('service PATH de-duplicates node bin and platform dirs', () => {
  const path = buildServicePath({
    homeDir: '/Users/test',
    nodePath: '/usr/bin/node',
    platform: 'darwin',
  });

  assert.equal(path.split(':').filter((entry) => entry === '/usr/bin').length, 1);
});

test('launchd plist pins service command, environment, logs, and keepalive', () => {
  const spec = {
    animaHome: join(homedir(), '.anima'),
    args: ['web', '--host', '0.0.0.0', '--port', '4174'],
    id: 'web',
    legacyIds: ['ui'],
    logName: 'web.log',
    matchAny: [' web ', ' ui '],
    url: 'http://127.0.0.1:4174',
  };
  const plist = buildLaunchdPlist(spec, {
    animactl: '/Users/test/.anima/runtime/current/node_modules/@meetquinn/animactl/dist/server/cli/animactl.js',
    cwd: '/Users/test/.anima/runtime/current/node_modules/@meetquinn/animactl',
  });

  assert.equal(launchdLabel(spec), 'ai.meetquinn.anima.web');
  assert.match(plist, /<key>Label<\/key>\n<string>ai\.meetquinn\.anima\.web<\/string>/);
  assert.match(plist, /<string>web<\/string>\n<string>--host<\/string>\n<string>0\.0\.0\.0<\/string>/);
  assert.match(plist, /<key>ANIMA_HOME<\/key>\n<string>.*\/\.anima<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\n<string>.*\.kimi-code\/bin.*\/opt\/homebrew\/bin.*\/usr\/sbin.*<\/string>/s);
  assert.match(plist, /<key>StandardOutPath<\/key>\n<string>.*\/\.anima\/logs\/web\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\n<string>.*\/\.anima\/logs\/web\.log<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
});

test('launchd start/install/stop plans distinguish loaded from running', () => {
  assert.deepEqual(launchdStartActions({ loaded: true, running: true }), []);
  assert.deepEqual(launchdStartActions({ loaded: true, running: false }), ['kickstart']);
  assert.deepEqual(launchdStartActions({ loaded: false, running: false }), ['bootstrap', 'kickstart']);

  assert.deepEqual(launchdInstallActions({ loaded: true }), ['bootout', 'bootstrap', 'kickstart']);
  assert.deepEqual(launchdInstallActions({ loaded: false }), ['bootstrap', 'kickstart']);

  assert.deepEqual(launchdStopActions({ loaded: true }), ['bootout']);
  assert.deepEqual(launchdStopActions({ loaded: false }), []);
});

test('launchd action invocations dispatch bootstrap and kickstart distinctly', () => {
  const spec = {
    animaHome: join(homedir(), '.anima'),
    args: ['web', '--host', '0.0.0.0', '--port', '4174'],
    id: 'web',
    legacyIds: ['ui'],
    logName: 'web.log',
    matchAny: [' web ', ' ui '],
    url: 'http://127.0.0.1:4174',
  };
  const plistPath = '/Users/test/Library/LaunchAgents/ai.meetquinn.anima.web.plist';

  assert.deepEqual(launchdActionInvocation('bootout', spec, plistPath), {
    args: ['bootout', `gui/${process.getuid?.()}/ai.meetquinn.anima.web`],
    options: { allowFailure: true },
  });
  assert.deepEqual(launchdActionInvocation('bootstrap', spec, plistPath), {
    args: ['bootstrap', `gui/${process.getuid?.()}`, plistPath],
    options: { allowAlreadyLoaded: true },
  });
  assert.deepEqual(launchdActionInvocation('kickstart', spec, plistPath), {
    args: ['kickstart', `gui/${process.getuid?.()}/ai.meetquinn.anima.web`],
    options: {},
  });
});

test('launchd runtime parser treats print success without pid as loaded', () => {
  assert.deepEqual(parseLaunchdRuntime({ status: 0, stdout: 'state = waiting\n' }), { loaded: true });
  assert.deepEqual(parseLaunchdRuntime({ status: 0, stdout: 'state = running\n\tpid = 12345\n' }), {
    loaded: true,
    pid: 12345,
  });
  assert.deepEqual(parseLaunchdRuntime({ status: 113, stdout: '' }), { loaded: false });
});

test('systemd unit pins service command, environment, logs, restart, and install target', () => {
  const spec = {
    animaHome: join(homedir(), '.anima'),
    args: ['web', '--host', '0.0.0.0', '--port', '4174'],
    id: 'web',
    legacyIds: ['ui'],
    logName: 'web.log',
    matchAny: [' web ', ' ui '],
    url: 'http://127.0.0.1:4174',
  };
  const unit = buildSystemdUnit(spec, {
    animactl: '/home/test/.anima/runtime/current/node_modules/@meetquinn/animactl/dist/server/cli/animactl.js',
    cwd: '/home/test/.anima/runtime/current/node_modules/@meetquinn/animactl',
  });

  assert.equal(systemdServiceName(spec), 'ai.meetquinn.anima.web.service');
  assert.match(unit, /Description=Anima web service/);
  assert.match(unit, /WorkingDirectory=\/home\/test\/\.anima\/runtime\/current\/node_modules\/@meetquinn\/animactl/);
  assert.match(unit, /ExecStart="[^"]*node" "\/home\/test\/\.anima\/runtime\/current\/node_modules\/@meetquinn\/animactl\/dist\/server\/cli\/animactl\.js" "web" "--host" "0\.0\.0\.0"/);
  assert.match(unit, /Environment="ANIMA_HOME=.*\/\.anima"/);
  assert.match(unit, /Environment="PATH=[^"]*\.local\/bin[^"]*\.kimi-code\/bin[^"]*\/usr\/sbin[^"]*"/);
  assert.match(unit, /StandardOutput=append:.*\/\.anima\/logs\/web\.log/);
  assert.match(unit, /StandardError=append:.*\/\.anima\/logs\/web\.log/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /RestartSec=5/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('systemd start/install/stop plans distinguish loaded from running', () => {
  assert.deepEqual(systemdStartActions({ loaded: true, running: true }), []);
  assert.deepEqual(systemdStartActions({ loaded: true, running: false }), ['start']);
  assert.deepEqual(systemdStartActions({ loaded: false, running: false }), ['daemon-reload', 'start']);

  assert.deepEqual(systemdInstallActions(), ['daemon-reload', 'enable', 'restart']);

  assert.deepEqual(systemdStopActions({ loaded: true }), ['stop']);
  assert.deepEqual(systemdStopActions({ loaded: false }), []);

  assert.deepEqual(systemdUninstallActions({ loaded: true }), ['stop', 'disable']);
  assert.deepEqual(systemdUninstallActions({ loaded: false }), ['disable']);
});

test('systemd action invocations dispatch user service commands', () => {
  const spec = {
    animaHome: join(homedir(), '.anima'),
    args: ['web', '--host', '0.0.0.0', '--port', '4174'],
    id: 'web',
    legacyIds: ['ui'],
    logName: 'web.log',
    matchAny: [' web ', ' ui '],
    url: 'http://127.0.0.1:4174',
  };

  assert.deepEqual(systemdActionInvocation('daemon-reload', spec), {
    args: ['--user', 'daemon-reload'],
    options: {},
  });
  assert.deepEqual(systemdActionInvocation('enable', spec), {
    args: ['--user', 'enable', 'ai.meetquinn.anima.web.service'],
    options: {},
  });
  assert.deepEqual(systemdActionInvocation('disable', spec), {
    args: ['--user', 'disable', 'ai.meetquinn.anima.web.service'],
    options: {},
  });
  assert.deepEqual(systemdActionInvocation('restart', spec), {
    args: ['--user', 'restart', 'ai.meetquinn.anima.web.service'],
    options: {},
  });
  assert.deepEqual(systemdActionInvocation('stop', spec), {
    args: ['--user', 'stop', 'ai.meetquinn.anima.web.service'],
    options: {},
  });
});

test('systemd runtime parser reads active, inactive, and missing units', () => {
  assert.deepEqual(parseSystemdRuntime({
    status: 0,
    stdout: 'LoadState=loaded\nActiveState=active\nMainPID=12345\nUnitFileState=enabled\n',
  }), {
    active: true,
    enabled: true,
    loaded: true,
    pid: 12345,
  });
  assert.deepEqual(parseSystemdRuntime({
    status: 0,
    stdout: 'LoadState=loaded\nActiveState=inactive\nMainPID=0\nUnitFileState=disabled\n',
  }), {
    active: false,
    enabled: false,
    loaded: true,
  });
  assert.deepEqual(parseSystemdRuntime({
    status: 0,
    stdout: 'LoadState=loaded\nActiveState=activating\nMainPID=0\nUnitFileState=enabled\n',
  }), {
    active: false,
    enabled: true,
    loaded: true,
  });
  assert.deepEqual(parseSystemdRuntime({
    status: 1,
    stdout: 'LoadState=not-found\nActiveState=inactive\nMainPID=0\nUnitFileState=\n',
  }), {
    active: false,
    enabled: false,
    loaded: false,
  });
});

test('services status reports stopped agent and web with web URL', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-status-'));
  try {
    const configDir = join(tempDir, '.anima');
    await writeMinimalConfig(configDir, { dashboardPort: 4188 });

    const status = await runAnimactl(['services', 'status'], { env: { ANIMA_HOME: configDir } });

    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /agent \| stopped \| log .*\/agent\.log/);
    assert.match(status.stdout, /web \| stopped \| http:\/\/127\.0\.0\.1:4188 \| log .*\/web\.log/);
    assert.match(status.stdout, /\nDashboard: http:\/\/127\.0\.0\.1:4188/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services status uses default web port when config omits dashboardPort', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-status-default-'));
  try {
    const configDir = join(tempDir, '.anima');
    await writeMinimalConfig(configDir, {});

    const status = await runAnimactl(['services', 'status'], { env: { ANIMA_HOME: configDir } });

    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /web \| stopped \| http:\/\/127\.0\.0\.1:4174/);
    assert.match(status.stdout, /\nDashboard: http:\/\/127\.0\.0\.1:4174/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services status ignores a pid file for an unrelated process', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-running-'));
  try {
    const configDir = join(tempDir, '.anima');
    await writeMinimalConfig(configDir, {});
    await mkdir(join(configDir, 'run'), { recursive: true });
    await writeFile(join(configDir, 'run', 'agent.pid'), `${process.pid}\n`, 'utf8');

    const status = await runAnimactl(['services', 'status'], { env: { ANIMA_HOME: configDir } });

    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /agent \| stopped/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('server stays alive and logs invalid agents when none can start yet', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-server-empty-'));
  try {
    const configDir = join(tempDir, '.anima');
    await writeConfig(configDir, {
      agents: [{ id: 'anima', homePath: join(tempDir, 'missing-home') }],
    });

    const server = await runAnimactlUntil(['server'], {
      env: { ANIMA_HOME: configDir },
      until: ({ stderr }) => /Agent anima failed to start/.test(stderr),
    });

    assert.match(server.stderr, /Agent anima failed to start: Agent anima: homePath must be an existing directory/);
    assert.doesNotMatch(server.stderr, /No agents started/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('server skips tokenless local agents and stays idle', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-server-dormant-'));
  try {
    const configDir = join(tempDir, '.anima');
    const homePath = join(tempDir, 'home');
    await mkdir(homePath, { recursive: true });
    await writeConfig(configDir, {
      agents: [
        {
          id: 'anima',
          provider: { kind: 'claude-code' },
          homePath,
        },
      ],
    });

    const server = await runAnimactlUntil(['server'], {
      env: { ANIMA_HOME: configDir },
      until: ({ stdout }) => /Agent anima: idle \/ awaiting platform connection/.test(stdout),
    });

    assert.match(server.stdout, /Agent anima: idle \/ awaiting platform connection/);
    assert.doesNotMatch(server.stderr, /No agents started/);
    assert.doesNotMatch(server.stderr, /failed to start/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('server --agent only loads the requested agent', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-server-one-agent-'));
  try {
    const configDir = join(tempDir, '.anima');
    const homePath = join(tempDir, 'home');
    await mkdir(homePath, { recursive: true });
    await writeConfig(configDir, {
      agents: [
        {
          id: 'broken',
          provider: { kind: 'claude-code' },
          homePath: join(tempDir, 'missing-home'),
        },
        {
          id: 'scout',
          provider: { kind: 'claude-code' },
          homePath,
        },
      ],
    });

    const server = await runAnimactlUntil(['--agent', 'scout', 'server'], {
      env: { ANIMA_HOME: configDir },
      until: ({ stdout }) => /Agent scout: idle \/ awaiting platform connection/.test(stdout),
    });

    assert.match(server.stdout, /Agent scout: idle \/ awaiting platform connection/);
    assert.doesNotMatch(server.stderr, /No agents started/);
    assert.doesNotMatch(server.stderr + server.stdout, /broken/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services restart refuses to stop its own active runtime', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-self-restart-'));
  try {
    const configDir = join(tempDir, '.anima');
    await writeMinimalConfig(configDir, {});

    const restart = await runAnimactl(['services', 'restart'], {
      env: {
        ANIMA_INBOX_ITEM_ID: 'item_self_restart',
        ANIMA_HOME: configDir,
        ANIMA_RUNTIME_HOME: configDir,
      },
    });

    assert.equal(restart.status, 1);
    assert.match(restart.stderr, /Refusing to stop or restart the agent service from inside its own active runtime/);
    assert.doesNotMatch(restart.stdout, /stopped pid/);
    assert.doesNotMatch(restart.stdout, /started pid/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services install refuses to stop its own active runtime', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-self-install-'));
  try {
    const configDir = join(tempDir, '.anima');
    await writeMinimalConfig(configDir, {});

    const install = await runAnimactl(['services', 'install'], {
      env: {
        ANIMA_INBOX_ITEM_ID: 'item_self_install',
        ANIMA_HOME: configDir,
        ANIMA_RUNTIME_HOME: configDir,
      },
    });

    assert.equal(install.status, 1);
    assert.match(install.stderr, /Refusing to stop or restart the agent service from inside its own active runtime/);
    assert.doesNotMatch(install.stdout, /stopped pid/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services restart permits web-only restart from inside its own active runtime', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-self-web-restart-'));
  const childPids = new Set<number>();
  try {
    const configDir = join(tempDir, '.anima');
    await writeMinimalConfig(configDir, {});

    const restart = await runAnimactl(['services', 'restart', '--only', 'web'], {
      env: {
        ANIMA_INBOX_ITEM_ID: 'item_self_ui_restart',
        ANIMA_HOME: configDir,
        ANIMA_RUNTIME_HOME: configDir,
      },
    });
    for (const match of restart.stdout.matchAll(/started pid (\d+)/g)) {
      const pidText = match[1];
      if (pidText) childPids.add(Number.parseInt(pidText, 10));
    }

    assert.equal(restart.status, 0, restart.stderr || restart.stdout);
    assert.doesNotMatch(restart.stderr, /Refusing/);
    assert.doesNotMatch(restart.stdout, /agent:/);
    assert.match(restart.stdout, /web: started pid/);
  } finally {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('pid fallback cleanup stops a running web service before OS manager install', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-install-pid-cleanup-'));
  const childPids = new Set<number>();
  try {
    const configDir = join(tempDir, '.anima');
    await writeMinimalConfig(configDir, { dashboardPort: 4191 });

    const start = await runAnimactl(['services', 'start', '--only', 'web'], {
      env: { ANIMA_HOME: configDir },
    });
    collectStartedPids(start.stdout, childPids);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const [oldPid] = childPids;
    assert.ok(oldPid);
    assert.equal(pidIsRunning(oldPid), true);

    await stopPidFallbackService({
      animaHome: configDir,
      args: ['web', '--host', '0.0.0.0', '--port', '4191'],
      id: 'web',
      legacyIds: ['ui'],
      logName: 'web.log',
      matchAny: [' web ', ' ui '],
      url: 'http://127.0.0.1:4191',
    });

    assert.equal(pidIsRunning(oldPid), false);
    await assert.rejects(stat(join(configDir, 'run', 'web.pid')), /ENOENT/);
  } finally {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services restart proceeds when invoked from a different environment', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-cross-restart-'));
  const childPids = new Set<number>();
  try {
    const targetConfigDir = join(tempDir, 'target', '.anima');
    const otherConfigDir = join(tempDir, 'other', '.anima');
    await writeMinimalConfig(targetConfigDir, {});
    await writeMinimalConfig(otherConfigDir, {});

    const restart = await runAnimactl(['services', 'restart'], {
      env: {
        ANIMA_INBOX_ITEM_ID: 'item_cross_restart',
        ANIMA_HOME: targetConfigDir,
        ANIMA_RUNTIME_HOME: otherConfigDir,
      },
    });

    for (const match of restart.stdout.matchAll(/started pid (\d+)/g)) {
      const pidText = match[1];
      if (pidText) childPids.add(Number.parseInt(pidText, 10));
    }

    assert.equal(restart.status, 0, restart.stderr || restart.stdout);
    assert.doesNotMatch(restart.stderr, /Refusing/);
    assert.match(restart.stdout, /agent: started pid/);
    assert.match(restart.stdout, /web: started pid/);
  } finally {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services restart refuses to kill running or queued wake items by default', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-restart-gate-'));
  const childPids = new Set<number>();
  try {
    const configDir = join(tempDir, '.anima');
    await writeTokenlessAgentConfig(configDir, tempDir);

    const start = await runAnimactl(['services', 'start', '--only', 'agent'], {
      env: { ANIMA_HOME: configDir },
    });
    collectStartedPids(start.stdout, childPids);
    assert.equal(start.status, 0, start.stderr || start.stdout);

    await writeWakeQueue(configDir, 'anima', [
      slackInboxItem('item_running', 'running', 'Felix is working on this one.'),
      slackInboxItem('item_queued', 'queued', 'Queued message that could be claimed during restart.'),
    ]);

    const restart = await runAnimactl(['services', 'restart', '--idle-timeout-ms', '0'], {
      env: { ANIMA_HOME: configDir },
    });

    assert.equal(restart.status, 1);
    assert.match(restart.stderr, /Timed out waiting for agents to become idle/);
    assert.match(restart.stderr, /agent=anima status=running item=item_running/);
    assert.match(restart.stderr, /agent=anima status=queued item=item_queued/);
    assert.match(restart.stderr, /Use --force to restart anyway/);
    assert.doesNotMatch(restart.stdout, /stopped pid/);
    assert.doesNotMatch(restart.stdout, /started pid/);
    for (const pid of childPids) assert.equal(pidIsRunning(pid), true);
  } finally {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services restart requires drain-active and resume-running together', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-restart-drain-flags-'));
  try {
    const configDir = join(tempDir, '.anima');
    await writeMinimalConfig(configDir, {});

    const restart = await runAnimactl(['services', 'restart', '--drain-active'], {
      env: { ANIMA_HOME: configDir },
    });

    assert.equal(restart.status, 1);
    assert.match(restart.stderr, /--drain-active and --resume-running must be used together/);
    assert.doesNotMatch(restart.stdout, /stopped pid/);
    assert.doesNotMatch(restart.stdout, /started pid/);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services restart drain mode leaves queued wake items for the new worker', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-restart-drain-queued-'));
  const childPids = new Set<number>();
  try {
    const configDir = join(tempDir, '.anima');
    const resultPath = join(configDir, 'run', 'services-restart-result.json');
    await writeTokenlessAgentConfig(configDir, tempDir);

    const start = await runAnimactl(['services', 'start', '--only', 'agent'], {
      env: { ANIMA_HOME: configDir },
    });
    collectStartedPids(start.stdout, childPids);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const [oldPid] = childPids;
    assert.ok(oldPid);

    await writeWakeQueue(configDir, 'anima', [
      slackInboxItem('item_queued', 'queued', 'Queued message should remain queued.'),
    ]);

    const restart = await runAnimactl([
      'services',
      'restart',
      '--only',
      'agent',
      '--drain-active',
      '--resume-running',
    ], {
      env: { ANIMA_HOME: configDir, ANIMA_RESTART_RESULT_FILE: resultPath },
    });
    collectStartedPids(restart.stdout, childPids);

    assert.equal(restart.status, 0, restart.stderr || restart.stdout);
    assert.match(restart.stdout, new RegExp(`agent: stopped pid ${oldPid}`));
    assert.match(restart.stdout, /agent: started pid/);
    const wakeQueue = readWakeQueueItems(
      await readFile(join(configDir, 'agents', 'anima', 'wake-queue.json'), 'utf8'),
    ) as Record<string, { handling?: { status?: string } }>;
    assert.equal(wakeQueue['item_queued']?.handling?.status, 'queued');
  } finally {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services restart drain mode continues after timeout and leaves running item recoverable', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-restart-drain-timeout-'));
  const childPids = new Set<number>();
  try {
    const configDir = join(tempDir, '.anima');
    const resultPath = join(configDir, 'run', 'services-restart-result.json');
    await writeTokenlessAgentConfig(configDir, tempDir);

    const start = await runAnimactl(['services', 'start', '--only', 'agent'], {
      env: { ANIMA_HOME: configDir },
    });
    collectStartedPids(start.stdout, childPids);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const [oldPid] = childPids;
    assert.ok(oldPid);

    await writeWakeQueue(configDir, 'anima', [
      slackInboxItem('item_running', 'running', 'Long-running tool should block drain.'),
    ]);

    const restart = await runAnimactl([
      'services',
      'restart',
      '--only',
      'agent',
      '--drain-active',
      '--resume-running',
      '--drain-timeout-ms',
      '0',
    ], {
      env: { ANIMA_HOME: configDir, ANIMA_RESTART_RESULT_FILE: resultPath },
    });

    collectStartedPids(restart.stdout, childPids);

    assert.equal(restart.status, 0, restart.stderr || restart.stdout);
    assert.match(restart.stderr, /Timed out waiting for running agents to drain; continuing restart/);
    assert.match(restart.stdout, new RegExp(`agent: stopped pid ${oldPid}`));
    assert.match(restart.stdout, /agent: started pid/);
    assert.equal(pidIsRunning(oldPid), false);
    const wakeQueue = readWakeQueueItems(
      await readFile(join(configDir, 'agents', 'anima', 'wake-queue.json'), 'utf8'),
    ) as Record<string, {
      handling?: {
        drainRequestedAt?: string;
        drainTimeoutMs?: number;
        resumeReason?: string;
        status?: string;
      };
    }>;
    assert.equal(wakeQueue['item_running']?.handling?.status, 'queued');
    assert.equal(wakeQueue['item_running']?.handling?.resumeReason, 'runtime_restart');
    assert.equal(wakeQueue['item_running']?.handling?.drainRequestedAt, undefined);
    assert.equal(wakeQueue['item_running']?.handling?.drainTimeoutMs, undefined);
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
      interruptedCount?: number;
      requestedCount?: number;
      resumedCount?: number;
      status?: string;
    };
    assert.equal(result.status, 'succeeded');
    assert.equal(result.requestedCount, 1);
    assert.equal(result.resumedCount, 1);
    assert.equal(result.interruptedCount, 1);
  } finally {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services restart --force bypasses the wake queue idle gate', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-restart-force-'));
  const childPids = new Set<number>();
  try {
    const configDir = join(tempDir, '.anima');
    await writeTokenlessAgentConfig(configDir, tempDir);

    const start = await runAnimactl(['services', 'start', '--only', 'agent'], {
      env: { ANIMA_HOME: configDir },
    });
    collectStartedPids(start.stdout, childPids);
    assert.equal(start.status, 0, start.stderr || start.stdout);
    const [oldPid] = childPids;
    assert.ok(oldPid);

    await writeWakeQueue(configDir, 'anima', [
      slackInboxItem('item_running', 'running', 'Force restart intentionally ignores this item.'),
    ]);

    const restart = await runAnimactl(['services', 'restart', '--only', 'agent', '--force'], {
      env: { ANIMA_HOME: configDir },
    });
    collectStartedPids(restart.stdout, childPids);

    assert.equal(restart.status, 0, restart.stderr || restart.stdout);
    assert.match(restart.stdout, new RegExp(`agent: stopped pid ${oldPid}`));
    assert.match(restart.stdout, /agent: started pid/);
  } finally {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services start rotates oversized logs and keeps five generations', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'anima-services-log-rotate-'));
  const childPids = new Set<number>();
  try {
    const configDir = join(tempDir, '.anima');
    await writeMinimalConfig(configDir, {});
    const logsDir = join(configDir, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, 'web.log'), 'x'.repeat(20 * 1024 * 1024), 'utf8');
    for (let i = 1; i <= 5; i += 1) {
      await writeFile(join(logsDir, `web.log.${i}`), `old-${i}`, 'utf8');
    }

    const start = await runAnimactl(['services', 'start', '--only', 'web'], {
      env: { ANIMA_HOME: configDir },
    });
    for (const match of start.stdout.matchAll(/started pid (\d+)/g)) {
      const pidText = match[1];
      if (pidText) childPids.add(Number.parseInt(pidText, 10));
    }

    assert.equal(start.status, 0, start.stderr || start.stdout);
    assert.match(await readFile(join(logsDir, 'web.log'), 'utf8'), /starting web/);
    assert.equal((await stat(join(logsDir, 'web.log.1'))).size, 20 * 1024 * 1024);
    assert.equal(await readFile(join(logsDir, 'web.log.2'), 'utf8'), 'old-1');
    assert.equal(await readFile(join(logsDir, 'web.log.5'), 'utf8'), 'old-4');
    await assert.rejects(stat(join(logsDir, 'web.log.6')), /ENOENT/);
  } finally {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

async function writeMinimalConfig(configDir: string, extras: { dashboardPort?: number }): Promise<void> {
  const body: Record<string, unknown> = {
    agents: [
      {
        id: 'anima',
        slack: {
          appToken: 'xapp-fake',
          botToken: 'xoxb-fake',
        },
        provider: { kind: 'claude-code' },
      },
    ],
  };
  if (extras.dashboardPort !== undefined) body['dashboardPort'] = extras.dashboardPort;
  await writeConfig(configDir, body);
}

async function writeTokenlessAgentConfig(configDir: string, tempDir: string): Promise<void> {
  const homePath = join(tempDir, 'home');
  await mkdir(homePath, { recursive: true });
  await writeConfig(configDir, {
    agents: [
      {
        id: 'anima',
        homePath,
        provider: { kind: 'claude-code' },
      },
    ],
  });
}

async function writeConfig(configDir: string, body: Record<string, unknown>): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const { agents, ...env } = body;
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(env, null, 2)}\n`, 'utf8');
  if (Array.isArray(agents)) {
    for (const agent of agents) {
      const id = (agent as { id: string }).id;
      const agentDir = join(configDir, 'agents', id);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'config.json'), `${JSON.stringify(agent, null, 2)}\n`, 'utf8');
    }
  }
}

// The wake queue file may be the legacy flat record (as written by
// writeWakeQueue) or the v2 {items, seen} shape once the runtime rewrites it.
function readWakeQueueItems(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const items = parsed['items'];
  if (items && typeof items === 'object' && !Array.isArray(items) && 'seen' in parsed) {
    return items as Record<string, unknown>;
  }
  return parsed;
}

async function writeWakeQueue(configDir: string, agentId: string, items: Record<string, unknown>[]): Promise<void> {
  const wakeQueue = Object.fromEntries(items.map((item) => [String(item['id']), item]));
  await writeFile(
    join(configDir, 'agents', agentId, 'wake-queue.json'),
    `${JSON.stringify(wakeQueue, null, 2)}\n`,
    'utf8',
  );
}

function slackInboxItem(id: string, status: 'queued' | 'running', text: string): Record<string, unknown> {
  const createdAt = '2026-05-26T16:57:20.000Z';
  const handling: Record<string, unknown> = {
    createdAt,
    queuedAt: '2026-05-26T16:57:22.000Z',
    status,
    updatedAt: status === 'running' ? '2026-05-26T16:57:23.000Z' : '2026-05-26T16:57:22.000Z',
  };
  if (status === 'running') {
    handling['startedAt'] = '2026-05-26T16:57:23.000Z';
    handling['workerId'] = 'anima:12345';
  }
  return {
    channelId: 'C1',
    handling,
    id,
    kind: 'slack',
    messageTs: '1779814640.760089',
    receivedAt: createdAt,
    teamId: 'T1',
    text,
  };
}

function collectStartedPids(stdout: string, target: Set<number>): void {
  for (const match of stdout.matchAll(/started pid (\d+)/g)) {
    const pidText = match[1];
    if (pidText) target.add(Number.parseInt(pidText, 10));
  }
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runAnimactl(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Clear any inherited runtime env so refuse checks see a clean slate
    // unless the test explicitly opts back in via options.env.
    ANIMA_AGENT_ID: '',
    ANIMA_INBOX_ITEM_ID: '',
    ANIMA_HOME: '',
    ANIMA_RUNTIME_HOME: '',
    ...(options.env ?? {}),
  };
  const child = spawn(process.execPath, [animactl, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
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
  const [status] = (await once(child, 'exit')) as [number | null];
  return { status, stderr, stdout };
}

async function runAnimactlUntil(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    until: (output: { stderr: string; stdout: string }) => boolean;
  },
): Promise<{ status: number | null; stderr: string; stdout: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANIMA_AGENT_ID: '',
    ANIMA_INBOX_ITEM_ID: '',
    ANIMA_HOME: '',
    ANIMA_RUNTIME_HOME: '',
    ...(options.env ?? {}),
  };
  const child = spawn(process.execPath, [animactl, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  await new Promise<void>((resolveDone, reject) => {
    const finish = () => {
      if (options.until({ stderr, stdout })) {
        cleanup();
        resolveDone();
      }
    };
    const onStdout = (chunk: string) => {
      stdout += chunk;
      finish();
    };
    const onStderr = (chunk: string) => {
      stderr += chunk;
      finish();
    };
    const onExit = () => {
      cleanup();
      reject(new Error(`animactl exited before expected output. stdout=${stdout} stderr=${stderr}`));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for animactl output. stdout=${stdout} stderr=${stderr}`));
    }, options.timeoutMs ?? 2_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
  });

  const exit = once(child, 'exit') as Promise<[number | null]>;
  child.kill('SIGTERM');
  const [status] = await exit;
  return { status, stderr, stdout };
}
