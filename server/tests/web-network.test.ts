import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

import { ServerConfigStore } from '../storage/schema/server.store.js';
import { WebNetworkConfig, WebNetworkStore } from '../storage/schema/web-network.store.js';
import { ServerSettingsService } from '../settings/settings.service.js';
import { buildWebApp } from '../web/app.js';
import { startWebListeners } from '../web/host.js';
import { registerWebListenerAccess } from '../web/listener-access.js';
import { waitFor, withTempAnimaHome } from './helpers/harness.js';

const remote = { host: '100.70.30.79', allowedPeers: ['100.126.177.41'], allowedHosts: ['mini', '100.70.30.79'] };
const access = { ...remote, port: 4174 };
const config = { listeners: [{ host: '127.0.0.1' }, remote] };

test('web network config is opt-in, read-only and separate from shared agent config', async () => {
  await withTempAnimaHome(async (home) => {
    const root = new ServerConfigStore(home);
    const network = new WebNetworkStore(home);
    const settings = new ServerSettingsService(root, network);
    await writeFile(join(home, 'config.json'), '{"dashboardHost":"127.0.0.1","dashboardPort":4174}\n');
    const original = await readFile(join(home, 'config.json'), 'utf8');
    assert.deepEqual(await settings.getWebNetwork(), {});
    await assert.rejects(readFile(join(home, 'web-network.json')), { code: 'ENOENT' });
    await writeFile(join(home, 'web-network.json'), JSON.stringify(config));
    assert.deepEqual(await settings.getWebNetwork(), config);
    assert.deepEqual(await root.read(), JSON.parse(original));
    assert.equal(await readFile(join(home, 'config.json'), 'utf8'), original);
  });
});

for (const [name, bad] of Object.entries({
  unknown: { listener: [] },
  empty: { listeners: [] },
  wildcard: { listeners: [{ host: '0.0.0.0' }] },
  hostnameBind: { listeners: [{ host: 'localhost' }] },
  ipv6: { listeners: [{ host: '::' }] },
  noRestrictions: { listeners: [{ host: remote.host }] },
  noHosts: { listeners: [{ host: remote.host, allowedPeers: remote.allowedPeers }] },
  noPeers: { listeners: [{ host: remote.host, allowedHosts: remote.allowedHosts }] },
  emptyPeers: { listeners: [{ ...remote, allowedPeers: [] }] },
  namedPeer: { listeners: [{ ...remote, allowedPeers: ['macbook'] }] },
  wildcardHost: { listeners: [{ ...remote, allowedHosts: ['*.example.com'] }] },
  hostURL: { listeners: [{ ...remote, allowedHosts: ['http://mini'] }] },
  hostPort: { listeners: [{ ...remote, allowedHosts: ['mini:4174'] }] },
  duplicate: { listeners: [{ host: '127.0.0.1' }, { host: '127.0.0.1' }] },
  misspelledRestriction: { listeners: [{ ...remote, allowPeers: remote.allowedPeers }] },
})) {
  test(`web network rejects ${name} configuration`, () => {
    assert.throws(() => WebNetworkConfig.parse(bad));
  });
}

test('malformed and unreadable network files fail, not the legacy unrestricted default', async () => {
  await withTempAnimaHome(async (home) => {
    await writeFile(join(home, 'web-network.json'), '{');
    await assert.rejects(new WebNetworkStore(home).read());
    const other = join(home, 'other');
    await mkdir(join(other, 'web-network.json'), { recursive: true });
    await assert.rejects(new WebNetworkStore(other).read());
  });
});

test('restricted socket gate runs before parsing or handlers and ignores forwarded identity', async () => {
  const app = Fastify();
  registerWebListenerAccess(app, access);
  let calls = 0;
  app.route({ method: ['GET', 'POST'], url: '/fixture', handler: async () => { calls++; return { ok: true }; } });
  try {
    const allowed = { url: '/fixture', remoteAddress: remote.allowedPeers[0], headers: { host: 'mini:4174' } };
    assert.equal((await app.inject(allowed)).statusCode, 200);
    assert.equal((await app.inject({ ...allowed, method: 'POST', payload: {}, headers: { ...allowed.headers, origin: 'http://mini:4174', 'sec-fetch-site': 'same-origin' } })).statusCode, 200);
    assert.equal(calls, 2);
    for (const options of [
      { remoteAddress: '100.126.177.42' },
      { remoteAddress: '127.0.0.1', headers: { host: 'mini:4174', 'x-forwarded-for': remote.allowedPeers[0]!, forwarded: `for=${remote.allowedPeers[0]}` } },
      { headers: { host: 'evil.invalid:4174', 'x-forwarded-host': 'mini:4174' } },
      { headers: { host: 'mini:4175' } },
      { headers: { host: 'mini:4174', origin: 'https://evil.invalid' } },
      { headers: { host: 'mini:4174', origin: 'http://100.70.30.79:4174' } },
      { headers: { host: 'mini:4174', 'sec-fetch-site': 'cross-site' } },
    ]) {
      const response = await app.inject({ ...allowed, ...options });
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), { error: 'network_access_denied' });
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    const invalidBody = await app.inject({ url: '/fixture', method: 'POST', remoteAddress: '100.126.177.42', headers: { host: 'mini:4174', 'content-type': 'application/json' }, payload: '{' });
    assert.equal(invalidBody.statusCode, 403);
    assert.equal(calls, 2, 'no refused request reached the handler');
  } finally { await app.close(); }
});

test('actual web app gates health and assets, while loopback retains the existing reverse-proxy path', async () => {
  await withTempAnimaHome(async () => {
    const restricted = buildWebApp(access);
    const local = buildWebApp();
    try {
      for (const url of ['/', '/api/health', '/api/server-info']) {
        const denied = await restricted.inject({ url, remoteAddress: '100.126.177.42', headers: { host: 'mini:4174' } });
        assert.equal(denied.statusCode, 403);
      }
      const good = await restricted.inject({ url: '/api/health', remoteAddress: '100.126.177.41', headers: { host: 'mini:4174' } });
      assert.equal(good.statusCode, 200);
      const proxy = await local.inject({ url: '/api/health', remoteAddress: '127.0.0.1', headers: { host: 'home.example.com', origin: 'https://home.example.com', 'x-forwarded-for': '203.0.113.1' } });
      assert.equal(proxy.statusCode, 200);
    } finally { await restricted.close(); await local.close(); }
  });
});

const close = async (servers: Server[]) => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
};
const portOf = (server: Server) => {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
};

test('two web listener instances have independent access rules and close together', async () => {
  await withTempAnimaHome(async () => {
    // Ephemeral ports avoid relying on a test machine having a second interface.
    const servers = await startWebListeners([{ host: '127.0.0.1' }, { ...remote, host: '127.0.0.1' }], 0);
    try {
      assert.equal(servers.length, 2);
      const local = await fetch(`http://127.0.0.1:${portOf(servers[0]!)}/api/health`);
      assert.equal(local.status, 200);
      const denied = await fetch(`http://127.0.0.1:${portOf(servers[1]!)}/api/health`, { headers: { host: 'mini:0', 'x-forwarded-for': '100.126.177.41' } });
      assert.equal(denied.status, 403);
    } finally { await close(servers); }
    assert.ok(servers.every((server) => !server.listening));
  });
});

test('later bind failure closes earlier listeners and preserves the original bind error', async () => {
  await withTempAnimaHome(async () => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = portOf(reservation);
    await close([reservation]);
    // Duplicate is rejected in file validation; here it deterministically causes
    // a later EADDRINUSE without depending on any real host interface/service.
    await assert.rejects(startWebListeners([{ host: '127.0.0.1' }, { host: '127.0.0.1' }], port), { code: 'EADDRINUSE' });
    const probe = createServer();
    probe.listen(port, '127.0.0.1');
    await once(probe, 'listening');
    await close([probe]);
  });
});

test('web entrypoint loads the separate network file and shuts down without starting agents', async () => {
  await withTempAnimaHome(async (home) => {
    await writeFile(join(home, 'web-network.json'), JSON.stringify({ listeners: [{ host: '127.0.0.1' }] }));
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = portOf(reservation);
    await close([reservation]);
    const entry = fileURLToPath(new URL('../web/host.js', import.meta.url));
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { startWebHost } from ${JSON.stringify(entry)}; await startWebHost({host:'192.0.2.25',port:${port}});`,
    ], { env: { HOME: home, ANIMA_HOME: home, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    try {
      await waitFor(() => output.includes('Anima web listening') || child.exitCode !== null, { timeoutMs: 8000 });
      assert.equal(child.exitCode, null, output);
      assert.match(output, new RegExp(`127\\.0\\.0\\.1:${port}`));
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(response.status, 200);
    } finally {
      // Only this test-owned child, not a supervisor-managed/live web process.
      child.kill('SIGTERM');
      try {
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 5000 });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    }
    assert.equal(child.exitCode, 0, output);
    await assert.rejects(readFile(join(home, 'run', 'agent.pid')), { code: 'ENOENT' });
  });
});
