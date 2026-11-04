import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { join } from 'node:path';
import { withFileLock } from '../storage/lock.js';
import { DEFAULT_LINEAR_LISTENER, LinearInstallRequest, type LinearClientSecretResult, type LinearStatus } from '../../shared/linear.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { AgentStore } from '../storage/schema/agent.store.js';
import { serverConfigStore } from '../storage/schema/server.store.js';
import { LinearStore, type LinearInstallation } from '../storage/schema/linear.store.js';
import { LinearDiagnosticsStore } from '../storage/schema/linear-diagnostics.store.js';
import { LinearListenerStore } from '../storage/schema/linear-listener.store.js';
import { processAlive } from '../runtime/item-state.js';
import { LinearApiError, LinearClient } from './client.js';
import { isActiveRequest } from './receipt-state.js';

// Linear can mark a session stale after 30 minutes without activity; use the same quiet period.
const UNANSWERED_AFTER_MS = 30 * 60_000;

const Identity = z.object({ viewer: z.object({ id: z.string().uuid(), app: z.literal(true), name: z.string().nullish() }), organization: z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(256) }),
  applicationInfo: z.object({ clientId: z.string() }),
});

export type LinearCallbackOutcome = 'connected' | 'declined' | 'failed';

/**
 * The callback could not be tied to a pending attempt in this dashboard
 * session (unknown, removed, expired, replayed or another session's state).
 * Callers must not attribute it to any agent.
 */
export class LinearCallbackRejected extends Error {}

/**
 * Thrown by finish() only after it has checked the session binding: the
 * attempt belonged to this session and its exchange failed. This is the only
 * failure that may name the agent.
 */
export class LinearCallbackFailed extends Error {}

export class LinearIdentityService {
  readonly store: LinearStore;
  constructor(readonly agentId: string, readonly client = new LinearClient(), store = new LinearStore(agentId)) {
    this.store = store;
  }

  // Names the agent only when finish() vouches for the session binding: a
  // completed or declined attempt, or a LinearCallbackFailed thrown after the
  // check. Anything else, including a read error before the check, is
  // rethrown and names no agent.
  static async finishCallback(state: string, code: string | undefined, binding: string): Promise<{ agentId: string; outcome: LinearCallbackOutcome }> {
    for (const agent of await defaultAgentRegistryService.listAgentConfigs()) {
      if ((await new LinearStore(agent.id).read()).pending?.id === state) {
        try {
          return { agentId: agent.id, outcome: await new LinearIdentityService(agent.id).finish(state, code, binding) };
        } catch (error) {
          if (error instanceof LinearCallbackFailed) return { agentId: agent.id, outcome: 'failed' };
          throw error;
        }
      }
    }
    throw new LinearCallbackRejected('Linear installation expired or was removed.');
  }

  // The public callback only relays to the dashboard that started this attempt.
  // It never exchanges a code or accepts a caller-supplied redirect destination.
  static async callbackReturnUrl(state: string): Promise<string | undefined> {
    for (const agent of await defaultAgentRegistryService.listAgentConfigs()) {
      const pending = (await new LinearStore(agent.id).read()).pending;
      if (pending?.id === state && pending.expiresAt > Date.now()) return pending.returnUrl;
    }
    throw new Error('Linear installation expired or was removed. Prepare authorization again.');
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
      result.installationId = file.installation.id;
      result.clientSecretSaved = Boolean(file.installation.clientSecret);
      if (file.installation.clientRejected && !file.installation.revoked) result.clientRejected = true;
      result.organizationId = file.installation.organizationId;
      result.appUserId = file.installation.appUserId;
      if (file.installation.workspaceName) result.workspaceName = file.installation.workspaceName;
    } else if (file.pending) result.clientId = file.pending.clientId;
    if (file.lastSignedWebhookAt) result.lastSignedWebhookAt = file.lastSignedWebhookAt;
    // The runtime does not answer for the agent. Count sessions where a finished request has no
    // recorded reply and the session has had no recorded activity for 30 minutes. These are local
    // records, not Linear's session state: a raw API reply or a later error can change what Linear
    // shows. Judge the whole session: a new prompt or any later activity refreshes it, and a
    // request that is still queued or running has not ended.
    if (file.installation && !file.installation.revoked) {
      const sessions = new Map<string, { unanswered: boolean; open: boolean; lastAt: number }>();
      for (const r of Object.values(file.receipts)) {
        const session = sessions.get(r.sessionId) ?? { unanswered: false, open: false, lastAt: 0 };
        if (r.kind === 'request' && r.state === 'awaiting') session.unanswered = true;
        if (isActiveRequest(r)) session.open = true;
        for (const at of [r.receivedAt, r.lastActivityAt]) if (at) session.lastAt = Math.max(session.lastAt, Date.parse(at));
        sessions.set(r.sessionId, session);
      }
      const quietSince = Date.now() - UNANSWERED_AFTER_MS;
      const unanswered = [...sessions.values()].filter((s) => s.unanswered && !s.open && s.lastAt < quietSince).length;
      if (unanswered) result.unansweredSessions = unanswered;
    }
    if (file.lastError) result.lastError = file.lastError;
    else if (file.pending && file.pending.expiresAt <= Date.now()) result.lastError = 'Installation expired or is being completed. Remove it and prepare again if authorization did not finish.';
    const listener = (await serverConfigStore.read()).linearWebhook ?? DEFAULT_LINEAR_LISTENER;
    result.listener = listener;
    result.listenerStatus = { state: 'unknown' };
    // The dashboard outlives the daemon. A saved bind is only a recent local
    // observation, and cannot establish public ingress reachability.
    const observation = await new LinearListenerStore(this.store.animaHome).read().catch(() => undefined);
    if (observation) {
      const age = Date.now() - Date.parse(observation.observedAt);
      const sameAddress = observation.address?.host === listener.host && observation.address?.port === listener.port;
      if (age >= 0 && age < 90_000 && sameAddress && processAlive(observation.processId)) {
        result.listenerStatus = { state: observation.state, observedAt: observation.observedAt };
        if (observation.reason) result.listenerStatus.reason = observation.reason;
      }
    }
    return result;
  }

  async begin(input: LinearInstallRequest, binding: string, returnUrl?: string): Promise<{ authorizationUrl: string }> {
    return withFileLock(join(this.store.animaHome, 'linear-installation'), this.store.animaHome, () => this.beginLocked(input, binding, returnUrl));
  }

  private async beginLocked(input: LinearInstallRequest, binding: string, returnUrl?: string): Promise<{ authorizationUrl: string }> {
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
    const pending = {
      id: randomBytes(32).toString('base64url'), clientId: request.clientId, clientSecret: request.clientSecret,
      signingSecret: request.signingSecret, callbackUrl: request.callbackUrl, returnUrl,
      verifier: randomBytes(32).toString('base64url'), binding, expiresAt: Date.now() + 10 * 60_000,
    };
    await this.store.update((file) => {
      if (file.installation && !file.installation.revoked) throw new Error('Remove the installed identity before replacing it.');
      return { ...file, pending, lastError: undefined };
    });
    const url = new URL('https://linear.app/oauth/authorize');
    url.search = new URLSearchParams({
      client_id: pending.clientId, redirect_uri: pending.callbackUrl, response_type: 'code',
      actor: 'app', scope: 'read,write,app:assignable,app:mentionable,customer:write,initiative:write,timeSchedule:write',
      state: pending.id, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
    }).toString();
    return { authorizationUrl: url.toString() };
  }

  async finish(state: string, code: string | undefined, binding: string): Promise<'connected' | 'declined'> {
    const file = await this.store.read();
    const pending = file.pending;
    if (!pending || pending.id !== state || pending.binding !== binding || pending.expiresAt <= Date.now()) throw new LinearCallbackRejected('Linear installation expired or does not belong to this dashboard session.');
    if (!code) {
      await this.store.update((current) => current.pending?.id === state && current.pending.expiresAt > Date.now()
        ? { ...current, pending: undefined, lastError: 'Linear authorization was declined. Prepare authorization again when ready.' } : current);
      return 'declined';
    }
    // Consume before exchange. Removal/replacement changes this nonce; completion cannot restore it.
    await this.store.update((current) => {
      if (current.pending?.id !== state || current.pending.expiresAt <= Date.now()) throw new LinearCallbackRejected('Linear installation changed.');
      return { ...current, pending: { ...pending, expiresAt: 0 } };
    });
    let stage: 'token' | 'identity' = 'token';
    try {
      // PKCE stays; Linear also requires the client secret at this endpoint.
      const tokens = await this.client.token({ grant_type: 'authorization_code', client_id: pending.clientId,
        ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}),
        redirect_uri: pending.callbackUrl, code_verifier: pending.verifier, code });
      stage = 'identity';
      const identity = await this.client.graphql(tokens.access_token, 'query($clientId:String!) { viewer { id app name } organization { id name } applicationInfo(clientId:$clientId) { clientId } }', { clientId: pending.clientId }, Identity);
      if (identity.applicationInfo.clientId !== pending.clientId) throw new Error('Linear application identity mismatch.');
      // The name only tells the agent what it is called; an unusable one is left out.
      const appName = identity.viewer.name?.replace(/\s+/g, ' ').trim();
      const installation: LinearInstallation = {
        id: randomUUID(), clientId: pending.clientId, signingSecret: pending.signingSecret,
        ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        organizationId: identity.organization.id, appUserId: identity.viewer.id, workspaceName: identity.organization.name,
        ...(appName && appName.length <= 256 ? { appName } : {}),
        accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000, revoked: false,
      };
      await this.store.update(async (current) => {
        if (current.pending?.id !== state || current.pending.expiresAt !== 0) throw new Error('Linear installation was removed or replaced.');
        await new AgentStore(this.agentId).update((agent) => ({ ...agent, linear: {
          connected: true, clientId: installation.clientId, organizationId: installation.organizationId, appUserId: installation.appUserId,
        } }));
        return { ...current, installation, pending: undefined, receipts: {}, operations: {}, sessionStarts: {}, lastError: undefined, lastSignedWebhookAt: undefined };
      });
      return 'connected';
    } catch (error) {
      const reason = error instanceof LinearApiError && error.failure
        ? error.failure === 'http' ? `HTTP ${error.status}${error.oauthError ? ` ${error.oauthError}` : ''}` : error.failure === 'network' ? 'connection failed' : 'invalid or rejected response'
        : 'verification or storage failed';
      const message = stage === 'token'
        ? `Linear authorization could not be exchanged (${reason}). Check the Client ID, client secret, registered redirect URL and network, then prepare authorization again.`
        : `Linear app identity could not be verified (${reason}). Check the app configuration and network, then prepare authorization again.`;
      await this.store.update((current) => current.pending?.id === state && current.pending.expiresAt === 0
        ? { ...current, pending: undefined, lastError: message } : current);
      throw new LinearCallbackFailed(message);
    }
  }

  async remove(): Promise<void> {
    await this.store.update(async () => {
      await new AgentStore(this.agentId).update((agent) => ({ ...agent, linear: undefined }));
      return { receipts: {}, operations: {}, sessionStarts: {} };
    });
  }

  async revoke(id: string, rejectedAccessToken?: string): Promise<void> {
    await this.store.update(async (file) => {
      if (file.installation?.id !== id
        || (rejectedAccessToken !== undefined && file.installation.accessToken !== rejectedAccessToken)) return file;
      await new AgentStore(this.agentId).update((agent) => {
        if (!agent.linear) return agent;
        return { ...agent, linear: { ...agent.linear, connected: false } };
      });
      return { ...file, installation: { ...file.installation, revoked: true, accessToken: '', refreshToken: '', signingSecret: '', clientSecret: undefined, clientRejected: undefined },
        lastError: 'Linear authorization was revoked; remove and reinstall the app.' };
    });
  }

  async accessToken(id: string): Promise<string> {
    let token = '';
    let revoked = false;
    let rejected: LinearApiError | undefined;
    await this.store.update(async (file) => {
      const install = file.installation;
      if (!install || install.id !== id || install.revoked) throw new Error('Linear identity is not authorized.');
      if (install.expiresAt > Date.now() + 60_000) { token = install.accessToken; return file; }
      try {
        const tokens = await this.client.token({ grant_type: 'refresh_token', client_id: install.clientId,
          ...(install.clientSecret ? { client_secret: install.clientSecret } : {}), refresh_token: install.refreshToken });
        token = tokens.access_token;
        return { ...file, installation: { ...install, accessToken: token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000, clientRejected: undefined } };
      } catch (error) {
        // invalid_client keeps the grant: the refresh token still works once
        // Linear accepts the app's credentials (e.g. a client secret added later).
        if (error instanceof LinearApiError && error.oauthError === 'invalid_client') {
          rejected = error;
          return install.clientRejected ? file : { ...file, installation: { ...install, clientRejected: true } };
        }
        if (!(error instanceof LinearApiError) || !error.revoked) throw error;
        revoked = true;
        return { ...file, installation: { ...install, revoked: true, accessToken: '', refreshToken: '', signingSecret: '', clientSecret: undefined, clientRejected: undefined }, lastError: 'Linear authorization was revoked; reinstall the app.' };
      }
    });
    if (rejected) throw rejected;
    if (revoked) { await this.revoke(id); throw new Error('Linear authorization was revoked.'); }
    return token;
  }

  /**
   * Stores a client secret for an installation made before Anima kept one.
   * The secret is proven by refreshing with it, and saved only together with
   * the tokens that refresh returned, in the same locked update that automatic
   * refresh, removal and revocation use. A changed installation is never written.
   */
  async saveClientSecret(installationId: string, clientSecret: string): Promise<LinearClientSecretResult> {
    await defaultAgentRegistryService.serviceFor(this.agentId).getConfig();
    let result: LinearClientSecretResult | undefined;
    let refreshed = false;
    let revoked = false;
    try {
      await this.store.update(async (file) => {
        const install = file.installation;
        if (!install || install.id !== installationId || install.revoked) { result = 'changed'; return file; }
        let tokens: Awaited<ReturnType<LinearClient['token']>>;
        try {
          tokens = await this.client.token({ grant_type: 'refresh_token', client_id: install.clientId, client_secret: clientSecret, refresh_token: install.refreshToken });
        } catch (error) {
          if (error instanceof LinearApiError && error.oauthError === 'invalid_client') { result = 'rejected'; return file; }
          if (error instanceof LinearApiError && error.revoked) {
            result = 'expired'; revoked = true;
            return { ...file, installation: { ...install, revoked: true, accessToken: '', refreshToken: '', signingSecret: '', clientSecret: undefined, clientRejected: undefined }, lastError: 'Linear authorization was revoked; reinstall the app.' };
          }
          // A 200 with an unreadable body may already have rotated the tokens.
          result = error instanceof LinearApiError && error.failure === 'response' ? 'unsaved' : 'unavailable';
          return file;
        }
        refreshed = true;
        result = 'saved';
        return { ...file, installation: { ...install, clientSecret, clientRejected: undefined,
          accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 } };
      });
    } catch {
      // The store could not be read or written. After a successful refresh the
      // new tokens are lost locally and the old refresh token may be spent.
      return refreshed ? 'unsaved' : 'unavailable';
    }
    if (revoked) await this.revoke(installationId);
    return result ?? 'unavailable';
  }

  // This is a credential snapshot for the agent, never the refresh token. Both
  // checks matter: an operator can disable or replace the identity during refresh.
  async credentials(installationId?: string): Promise<LinearCredentials> {
    const current = await this.authorizedInstallation(installationId);
    await this.accessToken(current.id);
    const latest = await this.authorizedInstallation(current.id);
    return {
      installationId: latest.id, accessToken: latest.accessToken,
      expiresAt: new Date(latest.expiresAt).toISOString(),
      organizationId: latest.organizationId, appUserId: latest.appUserId,
    };
  }

  async authorizedInstallation(installationId?: string): Promise<LinearInstallation> {
    const agent = await new AgentStore(this.agentId).read();
    if (!agent.enabled || !agent.linear?.connected) throw new Error('Linear agent is disabled or disconnected.');
    const { installation } = await this.store.read();
    if (!installation || (installationId !== undefined && installation.id !== installationId) || installation.revoked
      || installation.clientId !== agent.linear.clientId || installation.organizationId !== agent.linear.organizationId
      || installation.appUserId !== agent.linear.appUserId) throw new Error('Linear identity is not authorized.');
    return installation;
  }

  // Ordinary issue/API operations use the installed app identity. They do not
  // require an incoming AgentSession or an unanswered task receipt.
  async request<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>, operationName?: string): Promise<T> {
    const installation = await this.authorizedInstallation();
    return this.graphql(installation.id, query, variables, schema, operationName);
  }

  async graphql<T>(installationId: string, query: string, variables: Record<string, unknown>, schema: z.ZodType<T>, operationName?: string): Promise<T> {
    let accessToken: string;
    try { ({ accessToken } = await this.credentials(installationId)); }
    catch (error) { markNotSent(error); throw error; }
    try {
      return await this.client.graphql(accessToken, query, variables, schema, operationName);
    } catch (error) {
      // A request can finish after another process has refreshed the token. Only
      // revoke the credential it actually used; never retry a possibly applied write.
      if (error instanceof LinearApiError && error.revoked) await this.revoke(installationId, accessToken);
      throw error;
    }
  }
}

// Errors raised while getting a request's credential, before anything was sent to
// Linear. The error itself is passed on unchanged.
const notSent = new WeakSet<object>();
function markNotSent(error: unknown): void { if (typeof error === 'object' && error !== null) notSent.add(error); }
export function linearRequestNotSent(error: unknown): boolean { return typeof error === 'object' && error !== null && notSent.has(error); }

export interface LinearCredentials {
  installationId: string;
  accessToken: string;
  expiresAt: string;
  organizationId: string;
  appUserId: string;
}
