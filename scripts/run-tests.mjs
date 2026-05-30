#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const distTestsDir = 'dist/server/tests';

const groups = {
  unit: [
    'agent-config.test.js',
    'agent-seed-memory.test.js',
    'config.test.js',
    'inbox.test.js',
    'interactive-ask.test.js',
    'messages.test.js',
    'prompt-attachments.test.js',
    'reminders.test.js',
    'runtime.test.js',
    'runtime-upgrade.test.js',
    'slack-adapter.test.js',
    'slack-files.test.js',
    'slack-shortcuts.test.js',
    'slack.test.js',
    'state-cache.test.js',
    'subscriptions.test.js',
    'url-routes.test.js',
  ],
  api: [
    'kb.test.js',
    'web-api.test.js',
  ],
  runtime: [
    'agent-runtime.test.js',
    'cli-file.test.js',
    'cli-message.test.js',
    'runtime-worker.test.js',
    'services.test.js',
  ],
};

groups.fast = [...groups.unit, ...groups.api];
groups.all = readdirSync(distTestsDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

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
