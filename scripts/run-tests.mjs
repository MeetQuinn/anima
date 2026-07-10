#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const distTestsDir = 'dist/server/tests';
const sourceTestsDir = 'server/tests';

const quarantine = [
  // No quarantined tests.
];

const groups = {
  unit: [
    'active-item.test.js',
    'active-runtime.test.js',
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
    'provider-quiescent-waiters.test.js',
    'provider-usage.test.js',
    'inbox-slack-events.test.js',
    'reminders.test.js',
    'runtime-cli.test.js',
    'runtime-host-config-watch.test.js',
    'runtime.test.js',
    'runtime-upgrade.test.js',
    'slack-files.test.js',
    'slack-ingest.test.js',
    'slack-message-previews.test.js',
    'slack-shortcuts.test.js',
    'slack.test.js',
    'socket-mode-predicate.test.js',
    'state-cache.test.js',
    'subscriptions.test.js',
    'system-service.test.js',
    'url-routes.test.js',
  ],
  api: [
    'client-error-routes.test.js',
    'kb.test.js',
    'web-api-agent-home-files.test.js',
    'web-api-agent-ops.test.js',
    'web-api-server.test.js',
    'web-api-slack.test.js',
    'web-api-snapshot.test.js',
  ],
  runtime: [
    'agent-runtime-codex.test.js',
    'agent-runtime-claude.test.js',
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

auditTierMembership();

groups.fast = [...groups.unit, ...groups.api];
groups.all = [...groups.unit, ...groups.api, ...groups.runtime].sort();

const timeouts = {
  unit: 30_000,
  api: 30_000,
  fast: 45_000,
  runtime: 120_000,
  all: 150_000,
};

const group = process.argv[2] ?? 'fast';
const tests = groups[group];
if (!tests) {
  console.error(`Unknown test group "${group}". Expected one of: ${Object.keys(groups).join(', ')}`);
  process.exit(2);
}

const timeoutMs = timeouts[group] ?? 60_000;
const args = [
  '--test',
  `--test-timeout=${timeoutMs}`,
  '--test-concurrency=1',
  ...tests.map((name) => join(distTestsDir, name)),
];

console.log(`Running ${group} tests (${tests.length} files, timeout ${Math.round(timeoutMs / 1000)}s)`);
const child = spawn(process.execPath, args, {
  detached: process.platform !== 'win32',
  stdio: 'inherit',
});

let didTimeout = false;
const timer = setTimeout(() => {
  didTimeout = true;
  console.error(`\n${group} tests exceeded ${Math.round(timeoutMs / 1000)}s; terminating test process tree.`);
  killChildTree(child, 'SIGTERM');
  setTimeout(() => killChildTree(child, 'SIGKILL'), 2_000).unref();
}, timeoutMs).unref();

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (didTimeout) process.exit(124);
  if (signal) {
    console.error(`Test runner exited from signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  clearTimeout(timer);
  console.error(error);
  process.exit(1);
});

function auditTierMembership() {
  const sourceTests = readdirSync(sourceTestsDir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => name.replace(/\.ts$/, '.js'))
    .sort();
  const sourceSet = new Set(sourceTests);
  const tieredTests = [
    ...groups.unit,
    ...groups.api,
    ...groups.runtime,
    ...groups.quarantine,
  ];
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
