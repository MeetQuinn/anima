import { withAnimaHome } from '../anima-home.js';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentConfig } from '../../shared/agent-config.js';
import type { LinearListenerConfig, LinearListenerFailure } from '../../shared/linear.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearSessionService } from '../linear/session.service.js';
import { signatureMatches, verifyLinearWebhook } from '../linear/webhook.js';
import { LinearDiagnosticsStore } from '../storage/schema/linear-diagnostics.store.js';
import { LinearStore } from '../storage/schema/linear.store.js';
import { ServerConfigStore } from '../storage/schema/server.store.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import { LinearListenerStore, type LinearListenerObservation } from '../storage/schema/linear-listener.store.js';

export class LinearMessageTransport {
  private app?: FastifyInstance;
  private listenerKey?: string;
  private services = new Map<string, LinearSessionService>();
  private timer?: NodeJS.Timeout;
  private readonly rejectedClaims = new Map<string, { installationId: string; count: number }>();
  private nextDiagnosticsFlushAt = 0;
  private tickInFlight?: Promise<void>;
  private observation?: LinearListenerObservation;
  private pendingObservation?: LinearListenerObservation;
  private observationWrite?: Promise<void>;
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
    for (const agentId of this.rejectedClaims.keys()) if (!services.has(agentId)) this.rejectedClaims.delete(agentId);
    const config = (await new ServerConfigStore(this.animaHome).read()).linearWebhook;
    const key = this.services.size && config ? JSON.stringify(config) : undefined;
    if (key === this.listenerKey) {
      this.observeListener(this.app?.server.listening ? 'listening' : 'stopped', config);
      return;
    }
    await this.closeListener();
    if (!key || !config) { this.observeListener('stopped', config); return; }
    const app = this.buildApp();
    try { await app.listen({ host: config.host, port: config.port }); }
    catch (error) {
      await app.close();
      const code = (error as NodeJS.ErrnoException).code;
      const reason: LinearListenerFailure = code === 'EADDRINUSE' ? 'address_in_use'
        : code === 'EACCES' || code === 'EPERM' ? 'permission_denied'
        : code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'address_unavailable' : 'other';
      this.observeListener('failed', config, reason);
      this.logger.error('Linear webhook listener could not bind its configured host/port.');
      return;
    }
    this.app = app;
    this.listenerKey = key;
    this.observeListener('listening', config);
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
      const installations: Array<{ agentId: string; clientId: string; installationId: string }> = [];
      for (const service of this.services.values()) {
        const file = await service.identity.store.read();
        const install = file.installation;
        if (!install || install.revoked) continue;
        installations.push({ agentId: service.agentId, clientId: install.clientId, installationId: install.id });
        if (!signatureMatches(raw, signature, install.signingSecret)) continue;
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
      for (const install of installations) {
        if (install.clientId !== claimedClient) continue;
        const pending = this.rejectedClaims.get(install.agentId);
        this.rejectedClaims.set(install.agentId, { installationId: install.installationId,
          count: Math.min(Number.MAX_SAFE_INTEGER, (pending?.installationId === install.installationId ? pending.count : 0) + 1) });
      }
      return reply.code(403).send({ error: 'Invalid Linear signature' });
    }));
    return app;
  }

  async stop(): Promise<void> {
    await this.closeListener();
    if (this.observationWrite) await this.observationWrite;
  }

  private async closeListener(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const app = this.app;
    this.app = undefined;
    this.listenerKey = undefined;
    if (app) await app.close();
    this.observeListener('stopped', this.observation?.address);
    if (this.tickInFlight) await this.tickInFlight;
    await this.flushDiagnostics(true);
  }

  private observeListener(state: LinearListenerObservation['state'], address?: LinearListenerConfig, reason?: LinearListenerFailure): void {
    if (!address) return;
    const observation: LinearListenerObservation = { state, address, processId: process.pid, observedAt: new Date().toISOString() };
    if (reason) observation.reason = reason;
    this.observation = observation;
    this.pendingObservation = observation;
    this.flushListenerObservation();
  }

  private flushListenerObservation(): void {
    if (this.observationWrite) return;
    // Observations never gate binding or intake. Keep only the latest pending fact
    // while a write is slow, and preserve transition order across the web process.
    this.observationWrite = (async () => {
      while (this.pendingObservation) {
        const next = this.pendingObservation;
        this.pendingObservation = undefined;
        try { await new LinearListenerStore(this.animaHome).write(next); }
        catch { this.logger.error('Linear listener observation could not be saved.'); }
      }
    })().finally(() => {
      this.observationWrite = undefined;
      if (this.pendingObservation) this.flushListenerObservation();
    });
  }

  private async flushDiagnostics(stopping = false): Promise<void> {
    if (!this.rejectedClaims.size || (!stopping && Date.now() < this.nextDiagnosticsFlushAt)) return;
    // Public unsigned traffic only changes this bounded, small diagnostic file.
    // A crash can lose the unflushed count; it is not an authorization or health fact.
    this.nextDiagnosticsFlushAt = Date.now() + 60_000;
    for (const [agentId, pending] of this.rejectedClaims) {
      try {
        const current = (await new LinearStore(agentId, this.animaHome).read()).installation;
        if (current?.id === pending.installationId && !current.revoked) {
          await new LinearDiagnosticsStore(agentId, this.animaHome).addRejectedClaims(pending.installationId, pending.count);
        }
        const latest = this.rejectedClaims.get(agentId);
        if (latest?.installationId === pending.installationId) {
          if (latest.count > pending.count) this.rejectedClaims.set(agentId, { ...latest, count: latest.count - pending.count });
          else this.rejectedClaims.delete(agentId);
        }
      } catch { this.logger.error('Linear rejected-claim diagnostics could not be saved.'); }
    }
  }

  private tick(): void {
    if (this.tickInFlight) return;
    const services = [...this.services.values()];
    this.tickInFlight = Promise.all(services.map(async (service) => {
      try { await withAnimaHome(this.animaHome, () => service.tick()); }
      catch { this.logger.error('Linear receipt/status maintenance failed; inspect the Linear connection.'); }
    })).then(() => this.flushDiagnostics()).finally(() => { this.tickInFlight = undefined; });
  }
}
