import { join } from 'node:path';
import { LinearSetupRequest, type LinearSetup } from '../../shared/linear-setup.js';
import { resolveAnimaHome } from '../anima-home.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { withFileLock } from '../storage/lock.js';
import { LinearStore } from '../storage/schema/linear.store.js';
import { serverConfigStore } from '../storage/schema/server.store.js';

export class LinearSetupService {
  private async listenerLocked(): Promise<boolean> {
    for (const agent of await defaultAgentRegistryService.listAgentConfigs()) {
      if (agent.linear?.connected) return true;
      const file = await new LinearStore(agent.id).read();
      // Zero means the OAuth code was consumed and its exchange may still be in flight.
      if ((file.installation && !file.installation.revoked) || (file.pending && (file.pending.expiresAt === 0 || file.pending.expiresAt > Date.now()))) return true;
    }
    return false;
  }

  async read(): Promise<LinearSetup> {
    const config = await serverConfigStore.read();
    return {
      webhookUrl: config.linearWebhookUrl,
      listener: config.linearWebhook ?? { host: '127.0.0.1', port: 14185 },
      listenerLocked: await this.listenerLocked(),
    };
  }

  async save(input: LinearSetupRequest): Promise<LinearSetup> {
    const request = LinearSetupRequest.parse(input);
    const home = resolveAnimaHome();
    // Serialize with OAuth preparation, which also establishes the shared listener.
    return withFileLock(join(home, 'linear-installation'), home, async () => {
      const locked = await this.listenerLocked();
      await serverConfigStore.update((current) => {
        if (request.listener.port === (current.dashboardPort ?? 4174)) throw new Error('Webhook port must differ from the dashboard port.');
        if (locked && current.linearWebhook && (current.linearWebhook.host !== request.listener.host || current.linearWebhook.port !== request.listener.port)) {
          throw new Error('An installed app or an authorization in progress uses this listener. Keep its existing host and port.');
        }
        return { ...current, linearWebhook: request.listener, linearWebhookUrl: request.webhookUrl };
      });
      return { ...request, listenerLocked: locked };
    });
  }
}
