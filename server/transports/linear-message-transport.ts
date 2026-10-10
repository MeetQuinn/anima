import { withAnimaHome } from '../anima-home.js';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentConfig } from '../../shared/agent-config.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearSessionService } from '../linear/session.service.js';
import { signatureMatches, verifyLinearWebhook } from '../linear/webhook.js';
import { LinearStore } from '../storage/schema/linear.store.js';
import { ServerConfigStore } from '../storage/schema/server.store.js';
import { AgentStore } from '../storage/schema/agent.store.js';

export class LinearMessageTransport {
  private app?: FastifyInstance;
  private listenerKey?: string;
  private services = new Map<string, LinearSessionService>();
  private timer?: NodeJS.Timeout;
  private tickInFlight?: Promise<void>;
  constructor(private readonly animaHome: string, private readonly logger: Pick<Console, 'error'> = console) {}

  async reconcile(agents: AgentConfig[]): Promise<void> {
    const services = new Map<string, LinearSessionService>();
    for (const agent of agents) {
      if (!agent.enabled || !agent.linear?.connected) continue;
      const store = new LinearStore(agent.id, this.animaHome);
      const install = (await store.read()).installation;
      if (!install || install.revoked || !install.accessToken || !install.signingSecret
        || install.clientId !== agent.linear.clientId || install.organizationId !== agent.linear.organizationId || install.appUserId !== agent.linear.appUserId) continue;
      services.set(agent.id, new LinearSessionService(new LinearIdentityService(agent.id, undefined, store)));
    }
    this.services = services;
    const config = (await new ServerConfigStore(this.animaHome).read()).linearWebhook;
    const key = this.services.size && config ? JSON.stringify(config) : undefined;
    if (key === this.listenerKey) return;
    await this.stop();
    if (!key || !config) return;
    const app = this.buildApp();
    try { await app.listen({ host: config.host, port: config.port }); }
    catch { await app.close(); this.logger.error('Linear webhook listener could not bind its configured host/port.'); return; }
    this.app = app;
    this.listenerKey = key;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }

  buildApp(): FastifyInstance {
    const app = Fastify({ logger: false, bodyLimit: 256 * 1024, requestTimeout: 5000 });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    app.post('/webhook', async (request, reply) => withAnimaHome(this.animaHome, async () => {
      const raw = request.body as Buffer;
      const header = request.headers['linear-signature'];
      const signature = typeof header === 'string' ? header : undefined;
      for (const service of this.services.values()) {
        const file = await service.identity.store.read();
        const install = file.installation;
        if (!install || install.revoked || !signatureMatches(raw, signature, install.signingSecret)) continue;
        const agent = await new AgentStore(service.agentId).read();
        if (!agent.enabled || !agent.linear?.connected || agent.linear.clientId !== install.clientId
          || agent.linear.organizationId !== install.organizationId || agent.linear.appUserId !== install.appUserId) {
          return reply.code(503).send({ error: 'Linear agent is disabled or disconnected; retry after restoring it' });
        }
        let event;
        try { event = verifyLinearWebhook(raw, signature, install); }
        catch { return reply.code(403).send({ error: 'Invalid Linear webhook' }); }
        let deadline: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            service.receive(event, install),
            new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Persistence deadline')), 4000); }),
          ]);
        } catch { return reply.code(503).send({ error: 'Linear intake could not persist the request; retry delivery' }); }
        finally { if (deadline) clearTimeout(deadline); }
        this.tick();
        return { received: true };
      }
      // This hint is never authorization. Count only rejected claims for the named app.
      let claimedClient: string | undefined;
      try { claimedClient = (JSON.parse(raw.toString('utf8')) as { oauthClientId?: string }).oauthClientId; } catch { /* invalid JSON has no app claim */ }
      for (const service of this.services.values()) {
        await service.identity.store.update((file) => file.installation?.clientId === claimedClient
          ? { ...file, signatureFailures: file.signatureFailures + 1 } : file);
      }
      return reply.code(403).send({ error: 'Invalid Linear signature' });
    }));
    return app;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const app = this.app;
    this.app = undefined;
    this.listenerKey = undefined;
    if (app) await app.close();
  }

  private tick(): void {
    if (this.tickInFlight) return;
    const services = [...this.services.values()];
    this.tickInFlight = Promise.all(services.map(async (service) => {
      try { await withAnimaHome(this.animaHome, () => service.tick()); }
      catch { this.logger.error('Linear receipt/status maintenance failed; inspect the Linear connection.'); }
    })).then(() => undefined).finally(() => { this.tickInFlight = undefined; });
  }
}
