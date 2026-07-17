#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const distTestsDir = 'dist/server/tests';
const sourceTestsDir = 'server/tests';
const minimumNodeMajor = 24;

const currentNodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
if (!Number.isFinite(currentNodeMajor) || currentNodeMajor < minimumNodeMajor) {
  throw new Error(
    `Anima repository tests require Node.js ${minimumNodeMajor} or newer; ` +
      `current runtime is ${process.version}. Use the version pinned in .nvmrc.`,
  );
}

const quarantine = [
  // No quarantined tests.
];

const groups = {
  unit: [
    'active-item.test.js',
    'active-runtime.test.js',
    'activity-emitters.test.js',
    'agent-channels.test.js',
    'agent-config.test.js',
    'agent-health.test.js',
    'agent-seed-memory.test.js',
    'agent-skills.test.js',
    'attention-suggestion-activity.test.js',
    'channel-match.test.js',
    'chat-target-options.test.js',
    'chat-target-resolver.test.js',
    'config.test.js',
    'default-skills.test.js',
    'docs-retired-terms.test.js',
    'envelope.test.js',
    'feishu-processing-reaction.test.js',
    'feishu-ingest.test.js',
    'feishu-registration.test.js',
    'feishu-messages.test.js',
    'feishu-files.test.js',
    'file-cache-eviction.test.js',
    'inbox.test.js',
    'ingest-golden.test.js',
    'interactive-ask.test.js',
    'memory-coherence.test.js',
    'message.service.test.js',
    'message-profiles.test.js',
    'messages.test.js',
    'message-transport.test.js',
    'orientation.test.js',
    'outbound-effects.test.js',
    'outcome-line.test.js',
    'workspace-directory.test.js',
    'prompt-attachments.test.js',
    'prompt-template.test.js',
    'provider-failure.test.js',
    'provider-launch.test.js',
    'provider-line-buffer.test.js',
    'provider-cli.test.js',
    'provider-quiescent-waiters.test.js',
    'provider-accounts.test.js',
    'provider-usage.test.js',
    'grok-launch-args.test.js',
    'grok-tool-summary.test.js',
    'inbox-slack-events.test.js',
    'reminders.test.js',
    'runtime-cli.test.js',
    'runtime-host-config-watch.test.js',
    'runtime.test.js',
    'runtime-upgrade.test.js',
    'secret-handoff.test.js',
    'slack-files.test.js',
    'slack-ingest.test.js',
    'slack-message-previews.test.js',
    'slack-mrkdwn.test.js',
    'slack-shortcuts.test.js',
    'slack.test.js',
    'socket-mode-predicate.test.js',
    'state-cache.test.js',
    'subscriptions.test.js',
    'system-service.test.js',
    'test-runner.test.js',
    'url-routes.test.js',
    'write-root.test.js',
  ],
  api: [
    'client-error-routes.test.js',
    'kb.test.js',
    'read-only-runtime.test.js',
    'web-api-agent-home-files.test.js',
    'web-api-agent-ops.test.js',
    'web-api-server.test.js',
    'web-api-slack.test.js',
    'web-api-snapshot.test.js',
  ],
  runtime: [
    'agent-runtime-codex.test.js',
    'agent-runtime-claude.test.js',
    'agent-runtime-grok.test.js',
    'agent-runtime-kimi.test.js',
    'cli-env.test.js',
    'cli-errors.test.js',
    'cli-file.test.js',
    'cli-message.test.js',
    'runtime-worker-coherence.test.js',
    'runtime-worker-failures.test.js',
    'runtime-worker-followups.test.js',
    'runtime-worker-wake.test.js',
    'services.test.js',
  ],
  quarantine,
};

groups.fast = [...groups.unit, ...groups.api];
groups.all = [...groups.unit, ...groups.api, ...groups.runtime].sort();

const timeoutProfiles = {
  unit: { perTestMs: 30_000, suiteBaseMs: 30_000, suitePerFileMs: 2_000 },
  api: { perTestMs: 30_000, suiteBaseMs: 30_000, suitePerFileMs: 5_000 },
  fast: { perTestMs: 45_000, suiteBaseMs: 45_000 },
  runtime: { perTestMs: 60_000, suiteBaseMs: 60_000, suitePerFileMs: 15_000 },
  all: { perTestMs: 60_000, suiteBaseMs: 60_000 },
};

const fallbackTimeoutProfile = {
  perTestMs: 60_000,
  suiteBaseMs: 60_000,
  suitePerFileMs: 5_000,
};

export function testTimeoutsFor(group, testFiles) {
  const profile = timeoutProfiles[group] ?? fallbackTimeoutProfile;
  const suiteGrowthMs =
    group === 'fast' || group === 'all'
      ? testFiles.reduce((total, file) => total + compositeTierFileBudgetMs(group, file), 0)
      : testFiles.length * profile.suitePerFileMs;
  const derivedSuiteMs = profile.suiteBaseMs + suiteGrowthMs;
  return {
    perTestMs: profile.perTestMs,
    // Let Node's named per-test timeout fire and flush before the process-tree
    // watchdog becomes eligible. The suite limit also grows with serial files.
    suiteMs: Math.max(derivedSuiteMs, profile.perTestMs + 30_000),
  };
}

export function runTestFiles({ group, testPaths, perTestMs, suiteMs }) {
  if (!Number.isFinite(perTestMs) || perTestMs <= 0) {
    throw new Error(`perTestMs must be positive; received ${perTestMs}`);
  }
  if (!Number.isFinite(suiteMs) || suiteMs <= perTestMs) {
    throw new Error(
      `suiteMs must exceed perTestMs so Node can report a named test timeout first; ` +
        `received suiteMs=${suiteMs}, perTestMs=${perTestMs}`,
    );
  }

  const args = ['--test', `--test-timeout=${perTestMs}`, '--test-concurrency=1', ...testPaths];

  console.log(
    `Running ${group} tests (${testPaths.length} files, ` +
      `per-test ${formatSeconds(perTestMs)}, suite ${formatSeconds(suiteMs)})`,
  );
  const child = spawn(process.execPath, args, {
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });

  return new Promise((resolve) => {
    let didTimeout = false;
    let forceKillTimer;
    const timer = setTimeout(() => {
      didTimeout = true;
      console.error(
        `\n${group} tests exceeded suite budget ${formatSeconds(suiteMs)}; ` + 'terminating test process tree.',
      );
      killChildTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => killChildTree(child, 'SIGKILL'), 2_000);
      forceKillTimer.unref();
    }, suiteMs);
    timer.unref();

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (didTimeout) {
        resolve(124);
        return;
      }
      if (signal) {
        console.error(`Test runner exited from signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      console.error(error);
      resolve(1);
    });
  });
}

async function main() {
  auditTierMembership();

  const group = process.argv[2] ?? 'fast';
  const tests = groups[group];
  if (!tests) {
    console.error(`Unknown test group "${group}". Expected one of: ${Object.keys(groups).join(', ')}`);
    return 2;
  }

  const { perTestMs, suiteMs } = testTimeoutsFor(group, tests);
  return runTestFiles({
    group,
    perTestMs,
    suiteMs,
    testPaths: tests.map((name) => join(distTestsDir, name)),
  });
}

function compositeTierFileBudgetMs(group, file) {
  const owners = group === 'fast' ? ['unit', 'api'] : ['unit', 'api', 'runtime'];
  for (const owner of owners) {
    if (groups[owner].includes(file)) return timeoutProfiles[owner].suitePerFileMs;
  }
  throw new Error(`Cannot derive ${group}-tier timeout budget for unknown test file: ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}

function auditTierMembership() {
  const sourceTests = readdirSync(sourceTestsDir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => name.replace(/\.ts$/, '.js'))
    .sort();
  const sourceSet = new Set(sourceTests);
  const tieredTests = [...groups.unit, ...groups.api, ...groups.runtime, ...groups.quarantine];
  const tierCounts = new Map();
  for (const name of tieredTests) tierCounts.set(name, (tierCounts.get(name) ?? 0) + 1);
  const tieredSet = new Set(tieredTests);
  const untiered = sourceTests.filter((name) => !tieredSet.has(name));
  const stale = tieredTests.filter((name) => !sourceSet.has(name));
  const duplicated = Array.from(tierCounts)
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();

  if (untiered.length === 0 && stale.length === 0 && duplicated.length === 0) return;

  console.error('Test tier membership is out of date.');
  if (untiered.length > 0) {
    console.error('\nUntiered server/tests/*.test.ts files:');
    for (const name of untiered) console.error(`  - ${name}`);
  }
  if (stale.length > 0) {
    console.error('\nTier entries without a matching server/tests/*.test.ts file:');
    for (const name of stale) console.error(`  - ${name}`);
  }
  if (duplicated.length > 0) {
    console.error('\nTest files listed in more than one tier:');
    for (const name of duplicated) console.error(`  - ${name}`);
  }
  process.exit(1);
}

function killChildTree(childProcess, signal) {
  if (!childProcess.pid) return;
  try {
    if (process.platform === 'win32') {
      childProcess.kill(signal);
    } else {
      process.kill(-childProcess.pid, signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function formatSeconds(timeoutMs) {
  return timeoutMs < 1_000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`;
}
