import type { Command } from 'commander';
import { z } from 'zod';

import { resolveAnimaHome } from '../anima-home.js';
import { startRuntimeHost } from '../runtime/host.js';
import {
  AGENT_SERVICE_LOG,
  serviceLogPath,
  startLiveServiceLogRotation,
  WEB_SERVICE_LOG,
} from '../services/service-log.js';
import { startWebHost } from '../web/host.js';

const GlobalFlags = z.object({
  agent: z.string().optional(),
});

const ServerSchema = GlobalFlags;

const WebSchema = GlobalFlags.extend({
  host: z.string().optional(),
  port: z.coerce.number().int().positive().optional(),
});

type ServerOptions = z.infer<typeof ServerSchema>;
type WebOptions = z.infer<typeof WebSchema>;

export function registerServiceCommands(program: Command): void {
  program
    .command('server')
    .description('Run the Anima server: Slack listener, reminder scheduler, and worker loop')
    .action(async (_, command) => {
      const opts = ServerSchema.parse(command.optsWithGlobals());
      await server(opts);
    });

  program
    .command('web')
    .description('Run the local Anima web app')
    .option('--host <host>')
    .option('--port <port>')
    .action(async (_, command) => {
      const opts = WebSchema.parse(command.optsWithGlobals());
      await web(opts);
    });
}

async function server(opts: ServerOptions): Promise<void> {
  startLiveServiceLogRotation(serviceLogPath({ animaHome: resolveAnimaHome(), logName: AGENT_SERVICE_LOG }));
  await startRuntimeHost(opts);
}

async function web(opts: WebOptions): Promise<void> {
  startLiveServiceLogRotation(serviceLogPath({ animaHome: resolveAnimaHome(), logName: WEB_SERVICE_LOG }));
  await startWebHost(opts);
}
