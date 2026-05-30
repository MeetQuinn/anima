import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanServiceEnv } from '../services/env.js';

const animactl = resolve('dist/server/cli/animactl.js');

test('cleanServiceEnv strips runtime item context before spawning services', () => {
  const env = cleanServiceEnv({
    ANIMA_AGENT_ID: 'milo',
    ANIMA_HOME: '/tmp/source-home',
    ANIMA_INBOX_ITEM_ID: 'item_123',
    ANIMA_RUNTIME_HOME: '/tmp/source-home',
    ANIMA_SLACK_BOT_TOKEN: 'xoxb-secret',
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
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
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
      until: ({ stdout }) => /Agent anima: idle \/ awaiting Slack connection/.test(stdout),
    });

    assert.match(server.stdout, /Agent anima: idle \/ awaiting Slack connection/);
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
      until: ({ stdout }) => /Agent scout: idle \/ awaiting Slack connection/.test(stdout),
    });

    assert.match(server.stdout, /Agent scout: idle \/ awaiting Slack connection/);
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

test('services restart refuses to kill running or queued inbox items by default', async () => {
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

    await writeInbox(configDir, 'anima', [
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

test('services restart drain mode leaves queued inbox items for the new worker', async () => {
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

    await writeInbox(configDir, 'anima', [
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
    const inbox = JSON.parse(await readFile(join(configDir, 'agents', 'anima', 'inbox.json'), 'utf8')) as Record<string, { handling?: { status?: string } }>;
    assert.equal(inbox['item_queued']?.handling?.status, 'queued');
  } finally {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services restart drain mode times out a running item without stopping services', async () => {
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

    await writeInbox(configDir, 'anima', [
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

    assert.equal(restart.status, 1);
    assert.match(restart.stderr, /Timed out waiting for running agents to reach a restart drain point/);
    assert.match(restart.stderr, /agent=anima status=running item=item_running/);
    assert.doesNotMatch(restart.stdout, /stopped pid/);
    assert.doesNotMatch(restart.stdout, /started pid/);
    assert.equal(pidIsRunning(oldPid), true);
    const inbox = JSON.parse(await readFile(join(configDir, 'agents', 'anima', 'inbox.json'), 'utf8')) as Record<string, { handling?: { drainRequestedAt?: string; drainTimeoutMs?: number; status?: string } }>;
    assert.equal(inbox['item_running']?.handling?.status, 'running');
    assert.equal(inbox['item_running']?.handling?.drainRequestedAt, undefined);
    assert.equal(inbox['item_running']?.handling?.drainTimeoutMs, undefined);
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as {
      blockers?: Array<{ agentId?: string; itemId?: string; status?: string }>;
      reason?: string;
      status?: string;
    };
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'drain_timeout');
    assert.deepEqual(result.blockers?.map((blocker) => ({
      agentId: blocker.agentId,
      itemId: blocker.itemId,
      status: blocker.status,
    })), [
      { agentId: 'anima', itemId: 'item_running', status: 'running' },
    ]);
  } finally {
    for (const pid of childPids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('services restart --force bypasses the inbox idle gate', async () => {
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

    await writeInbox(configDir, 'anima', [
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

async function writeInbox(configDir: string, agentId: string, items: Record<string, unknown>[]): Promise<void> {
  const inbox = Object.fromEntries(items.map((item) => [String(item['id']), item]));
  await writeFile(
    join(configDir, 'agents', agentId, 'inbox.json'),
    `${JSON.stringify(inbox, null, 2)}\n`,
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
