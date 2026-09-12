import type { Server } from 'node:http';

import { resolveAnimaHome } from '../anima-home.js';
import { errorMessage } from '../ids.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import { createWebServer } from './app.js';
import type { WebListener } from '../storage/schema/web-network.store.js';
import type { WebListenerAccess } from './listener-access.js';

export interface WebHostOptions {
  host?: string;
  port?: number;
}

export async function startWebHost(opts: WebHostOptions = {}): Promise<void> {
  const animaHome = resolveAnimaHome();
  const host = opts.host ?? '127.0.0.1';
  const { port: configuredPort } = await defaultServerSettingsService.getDashboardSettings({
    defaultHost: host,
    defaultPort: 4174,
  });
  const port = opts.port ?? configuredPort;
  const network = await defaultServerSettingsService.getWebNetwork();
  const listeners = network.listeners ?? [{ host }];
  const servers = await startWebListeners(listeners, port);
  for (const listener of listeners) console.log(`Anima web listening on http://${listener.host}:${port}`);
  console.log(`Anima home: ${animaHome}`);
  await awaitShutdown(
    () => closeWebListeners(servers),
  );
}

export async function startWebListeners(listeners: WebListener[], port: number): Promise<Server[]> {
  const servers: Server[] = [];
  try {
    for (const listener of listeners) {
      let access: WebListenerAccess | undefined;
      if (listener.allowedPeers && listener.allowedHosts) {
        access = { allowedPeers: listener.allowedPeers, allowedHosts: listener.allowedHosts, port };
      }
      const server = await createWebServer(access);
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, listener.host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    }
    return servers;
  } catch (error) {
    // Never leave a partly started web host serving after another bind fails.
    for (const server of servers) server.closeAllConnections();
    await closeWebListeners(servers);
    throw error;
  }
}

async function closeWebListeners(servers: Server[]): Promise<void> {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}

async function awaitShutdown(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    let stopping = false;
    const handle = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      console.log(`Received ${signal}, shutting down...`);
      stop()
        .catch((error) => {
          console.error(`Shutdown error: ${errorMessage(error)}`);
        })
        .finally(() => resolveShutdown());
    };
    process.once('SIGINT', handle);
    process.once('SIGTERM', handle);
  });
}
