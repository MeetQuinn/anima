import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { join } from 'node:path';
import { withFileLock } from '../storage/lock.js';
import { LinearInstallRequest, type LinearStatus } from '../../shared/linear.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import { serverConfigStore } from '../storage/schema/server.store.js';
import { LinearStore, type LinearInstallation } from '../storage/schema/linear.store.js';
import { LinearDiagnosticsStore } from '../storage/schema/linear-diagnostics.store.js';
import { LinearListenerStore } from '../storage/schema/linear-listener.store.js';
import { processAlive } from '../runtime/item-state.js';
import { LinearApiError, LinearClient } from './client.js';

const Identity = z.object({ viewer: z.object({ id: z.string().uuid(), app: z.literal(true) }), organization: z.object({ id: z.string().uuid() }),
  applicationInfo: z.object({ clientId: z.string() }),
});

export class LinearIdentityService {
  readonly store: LinearStore;
  constructor(readonly agentId: string, readonly client = new LinearClient(), store = new LinearStore(agentId)) {
    this.store = store;
  }

  static async finishCallback(state: string, code: string, binding: string): Promise<void> {
    for (const agent of await defaultAgentRegistryService.listAgentConfigs()) {
      if ((await new LinearStore(agent.id).read()).pending?.id === state) {
        await new LinearIdentityService(agent.id).finish(state, code, binding);
        return;
      }
    }
    throw new Error('Linear installation expired or was removed.');
  }

  async status(): Promise<LinearStatus> {
    await defaultAgentRegistryService.serviceFor(this.agentId).getConfig();
    const file = await this.store.read();
    const diagnostics = await new LinearDiagnosticsStore(this.agentId, this.store.animaHome).read();
    const result: LinearStatus = {
      state: file.installation ? (file.installation.revoked ? 'revoked' : 'connected') : file.pending && file.pending.expiresAt > Date.now() ? 'installing' : 'not_configured',
      signatureFailures: diagnostics.installationId === file.installation?.id ? diagnostics.signatureFailures : 0,
    };
    if (file.installation) {
      result.clientId = file.installation.clientId;
      result.organizationId = file.installation.organizationId;
      result.appUserId = file.installation.appUserId;
    } else if (file.pending) result.clientId = file.pending.clientId;
    if (file.lastSignedWebhookAt) result.lastSignedWebhookAt = file.lastSignedWebhookAt;
    if (file.lastError) result.lastError = file.lastError;
    else if (file.pending && file.pending.expiresAt <= Date.now()) result.lastError = 'Installation expired or is being completed. Remove it and prepare again if authorization did not finish.';
    const listener = (await serverConfigStore.read()).linearWebhook;
    if (listener) result.listener = listener;
    result.listenerStatus = { state: 'unknown' };
    // The dashboard outlives the daemon. A saved bind is only a recent local
    // observation, and cannot establish public ingress reachability.
    const observation = await new LinearListenerStore(this.store.animaHome).read().catch(() => undefined);
    if (observation) {
      const age = Date.now() - Date.parse(observation.observedAt);
      const sameAddress = observation.address?.host === listener?.host && observation.address?.port === listener?.port;
      if (age >= 0 && age < 90_000 && sameAddress && processAlive(observation.processId)) {
        result.listenerStatus = { state: observation.state, observedAt: observation.observedAt };
        if (observation.reason) result.listenerStatus.reason = observation.reason;
      }
    }
    return result;
  }

  async begin(input: LinearInstallRequest, binding: string): Promise<{ authorizationUrl: string }> {
    return withFileLock(join(this.store.animaHome, 'linear-installation'), this.store.animaHome, () => this.beginLocked(input, binding));
  }

  private async beginLocked(input: LinearInstallRequest, binding: string): Promise<{ authorizationUrl: string }> {
    const request = LinearInstallRequest.parse(input);
    await defaultAgentRegistryService.serviceFor(this.agentId).getConfig();
    const agents = await defaultAgentRegistryService.listAgentConfigs();
    for (const agent of agents) {
      if (agent.id === this.agentId) continue;
      const file = await new LinearStore(agent.id).read();
      if (file.installation?.clientId === request.clientId || file.pending?.clientId === request.clientId) {
        throw new Error('Use a separate Linear app for each agent.');
      }
    }
    const config = await serverConfigStore.read();
    if (request.listener.port === (config.dashboardPort ?? 4174)) throw new Error('Webhook port must differ from the dashboard port.');
    if (config.linearWebhook && JSON.stringify(config.linearWebhook) !== JSON.stringify(request.listener)
      && agents.some((agent) => agent.linear?.connected)) throw new Error('All installed agents share one webhook listener; keep its existing host and port.');
    const pending = {
      id: randomBytes(32).toString('base64url'), clientId: request.clientId,
      signingSecret: request.signingSecret, callbackUrl: request.callbackUrl,
      verifier: randomBytes(32).toString('base64url'), binding, expiresAt: Date.now() + 10 * 60_000,
    };
    await this.store.update((file) => {
      if (file.installation && !file.installation.revoked) throw new Error('Remove the installed identity before replacing it.');
      return { ...file, pending, lastError: undefined };
    });
    await serverConfigStore.update((current) => ({ ...current, linearWebhook: request.listener }));
    const url = new URL('https://linear.app/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: pending.clientId, redirect_uri: pending.callbackUrl, response_type: 'code',
      actor: 'app', scope: 'read,write,app:assignable,app:mentionable',
      state: pending.id, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
    }).toString();
    return { authorizationUrl: url.toString() };
  }

  async finish(state: string, code: string, binding: string): Promise<void> {
    const file = await this.store.read();
    const pending = file.pending;
    if (!pending || pending.id !== state || pending.binding !== binding || pending.expiresAt <= Date.now()) throw new Error('Linear installation expired or does not belong to this dashboard session.');
    // Consume before exchange. Removal/replacement changes this nonce; completion cannot restore it.
    await this.store.update((current) => {
      if (current.pending?.id !== state || current.pending.expiresAt <= Date.now()) throw new Error('Linear installation changed.');
      return { ...current, pending: { ...pending, expiresAt: 0 } };
    });
    const tokens = await this.client.token({ grant_type: 'authorization_code', client_id: pending.clientId,
      redirect_uri: pending.callbackUrl, code_verifier: pending.verifier, code });
    const identity = await this.client.graphql(tokens.access_token, 'query($clientId:String!) { viewer { id app } organization { id } applicationInfo(clientId:$clientId) { clientId } }', { clientId: pending.clientId }, Identity);
    if (identity.applicationInfo.clientId !== pending.clientId) throw new Error('Linear application identity mismatch.');
    const installation: LinearInstallation = {
      id: randomUUID(), clientId: pending.clientId, signingSecret: pending.signingSecret,
      organizationId: identity.organization.id, appUserId: identity.viewer.id,
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000, revoked: false,
    };
    await this.store.update(async (current) => {
      if (current.pending?.id !== state || current.pending.expiresAt !== 0) throw new Error('Linear installation was removed or replaced.');
      await new AgentStore(this.agentId).update((agent) => ({ ...agent, linear: {
        connected: true, clientId: installation.clientId, organizationId: installation.organizationId, appUserId: installation.appUserId,
      } }));
      return { ...current, installation, pending: undefined, receipts: {}, operations: {}, lastError: undefined, lastSignedWebhookAt: undefined };
    });
  }

  async remove(): Promise<void> {
    await this.store.update(async () => {
      await new AgentStore(this.agentId).update((agent) => ({ ...agent, linear: undefined }));
      return { receipts: {}, operations: {} };
    });
  }

  async revoke(id: string): Promise<void> {
    await this.store.update(async (file) => {
      if (file.installation?.id !== id) return file;
      await new AgentStore(this.agentId).update((agent) => {
        if (!agent.linear) return agent;
        return { ...agent, linear: { ...agent.linear, connected: false } };
      });
      return { ...file, installation: { ...file.installation, revoked: true, accessToken: '', refreshToken: '', signingSecret: '' },
        lastError: 'Linear authorization was revoked; remove and reinstall the app.' };
    });
  }

  async accessToken(id: string): Promise<string> {
    let token = '';
    let revoked = false;
    await this.store.update(async (file) => {
      const install = file.installation;
      if (!install || install.id !== id || install.revoked) throw new Error('Linear identity is not authorized.');
      if (install.expiresAt > Date.now() + 60_000) { token = install.accessToken; return file; }
      try {
        const tokens = await this.client.token({ grant_type: 'refresh_token', client_id: install.clientId, refresh_token: install.refreshToken });
        token = tokens.access_token;
        return { ...file, installation: { ...install, accessToken: token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 } };
      } catch (error) {
        if (!(error instanceof LinearApiError) || !error.revoked) throw error;
        revoked = true;
        return { ...file, installation: { ...install, revoked: true, accessToken: '', refreshToken: '', signingSecret: '' }, lastError: 'Linear authorization was revoked; reinstall the app.' };
      }
    });
    if (revoked) { await this.revoke(id); throw new Error('Linear authorization was revoked.'); }
    return token;
  }

  async graphql<T>(installationId: string, query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    try {
      const agent = await new AgentStore(this.agentId).read();
      if (!agent.enabled || !agent.linear?.connected) throw new Error('Linear agent is disabled or disconnected.');
      const current = await this.store.read();
      if (!current.installation || current.installation.id !== installationId || current.installation.revoked
        || current.installation.clientId !== agent.linear.clientId || current.installation.organizationId !== agent.linear.organizationId
        || current.installation.appUserId !== agent.linear.appUserId) throw new Error('Linear identity is not authorized.');
      const token = await this.accessToken(installationId);
      const latest = await new AgentStore(this.agentId).read();
      const latestFile = await this.store.read();
      if (!latest.enabled || !latest.linear?.connected || latestFile.installation?.id !== installationId || latestFile.installation.revoked) throw new Error('Linear identity changed before the request.');
      return await this.client.graphql(token, query, variables, schema);
    }
    catch (error) {
      if (error instanceof LinearApiError && error.revoked) await this.revoke(installationId);
      throw error;
    }
  }
}
