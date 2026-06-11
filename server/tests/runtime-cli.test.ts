import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dashboardLaunchCommand,
  dashboardUrl,
  serviceCommandAfterRuntimeInstall,
} from '../cli/runtime-cli.js';

test('dashboard URL uses localhost for all-interface hosts', () => {
  assert.equal(dashboardUrl('0.0.0.0', 4174), 'http://127.0.0.1:4174');
  assert.equal(dashboardUrl('127.0.0.1', 4199), 'http://127.0.0.1:4199');
});

test('dashboard launch command maps to the platform browser launcher', () => {
  assert.deepEqual(dashboardLaunchCommand('http://127.0.0.1:4174', 'darwin'), {
    command: 'open',
    args: ['http://127.0.0.1:4174'],
  });
  assert.deepEqual(dashboardLaunchCommand('http://127.0.0.1:4174', 'win32'), {
    command: 'cmd',
    args: ['/c', 'start', '', 'http://127.0.0.1:4174'],
  });
  assert.deepEqual(dashboardLaunchCommand('http://127.0.0.1:4174', 'linux'), {
    command: 'xdg-open',
    args: ['http://127.0.0.1:4174'],
  });
});

test('managed start restarts services only when it upgraded an existing runtime', () => {
  assert.equal(
    serviceCommandAfterRuntimeInstall('start', {
      previousInstalled: false,
      runtimeChanged: true,
    }),
    'start',
  );
  assert.equal(
    serviceCommandAfterRuntimeInstall('start', {
      previousInstalled: true,
      runtimeChanged: false,
    }),
    'start',
  );
  assert.equal(
    serviceCommandAfterRuntimeInstall('start', {
      previousInstalled: true,
      runtimeChanged: true,
    }),
    'restart',
  );
  assert.equal(
    serviceCommandAfterRuntimeInstall('restart', {
      previousInstalled: true,
      runtimeChanged: true,
    }),
    'restart',
  );
});
