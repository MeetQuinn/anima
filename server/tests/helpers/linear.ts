import { randomUUID } from 'node:crypto';
import { writeAgentConfigs } from './harness.js';
import { AgentStore } from '../../storage/schema/agent.store.js';
import { LinearStore, type LinearInstallation } from '../../storage/schema/linear.store.js';
import { LinearClient } from '../../linear/client.js';
import { LinearIdentityService } from '../../linear/identity.service.js';
import { LinearSessionService } from '../../linear/session.service.js';
import type { LinearWebhook } from '../../linear/webhook.js';
import { linearQueryErrors } from './linear-schema.js';

export const install: LinearInstallation = { id: randomUUID(), clientId: 'a123456789012345678901234567890b5', organizationId: randomUUID(), appUserId: randomUUID(),
  signingSecret: 'synthetic-signing-secret-sentinel', accessToken: 'synthetic-access-sentinel', refreshToken: 'synthetic-refresh-sentinel', expiresAt: Date.now() + 24 * 60 * 60_000, revoked: false };
export const sessionId = randomUUID();
export const created = (session: string = sessionId): Extract<LinearWebhook, { type: 'AgentSessionEvent' }> => ({ type: 'AgentSessionEvent', action: 'created',
  organizationId: install.organizationId, oauthClientId: install.clientId, appUserId: install.appUserId, webhookTimestamp: Date.now(),
  agentSession: { id: session, organizationId: install.organizationId, appUserId: install.appUserId, creatorId: randomUUID(), creator: { name: 'Synthetic requester' } },
  promptContext: 'Synthetic request body',
});
export const prompted = (session = sessionId, stop = false): LinearWebhook => ({ ...created(session), type: 'AgentSessionEvent', action: 'prompted',
  agentActivity: { id: randomUUID(), agentSessionId: session, content: { type: 'prompt', body: stop ? '' : 'Only this new prompt' }, signal: stop ? 'stop' : null },
});

export class FakeLinear {
  posts: Array<{ id: string; agentSessionId: string; content: { type: string; body: string }; ephemeral: boolean }> = [];
  calls: Array<{ query: string; variables: Record<string, any> }> = [];
  tokenCalls = 0;
  loseResponse = false;
  failMutation = false;
  quotaUnauthorized = false;
  links: string[] = [];
  issueState = 'unstarted';
  issueDelegate: string | null = install.appUserId;
  tokenGate?: Promise<void>;
  fetch: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/oauth/token')) {
      this.tokenCalls++;
      await this.tokenGate;
      return new Response(JSON.stringify({ access_token: 'new-access-sentinel', refresh_token: 'new-refresh-sentinel', expires_in: 86400 }), { status: 200 });
    }
    const { query, variables } = JSON.parse(String(init?.body));
    this.calls.push({ query, variables });
    const errors = linearQueryErrors(query);
    if (errors.length) return new Response(JSON.stringify({ errors: errors.map((message) => ({ message })) }), { status: 400 });
    if (this.quotaUnauthorized) return new Response('{}', { status: 401 });
    let data: unknown;
    if (query.includes('viewer')) data = { viewer: { id: install.appUserId, app: true }, organization: { id: install.organizationId }, applicationInfo: { clientId: variables.clientId } };
    else if (query.includes('agentActivityCreate')) {
      if (this.failMutation) throw new Error('synthetic-network-error-secret');
      this.posts.push(variables.input);
      if (this.loseResponse) throw new Error('synthetic-lost-response-secret');
      data = { agentActivityCreate: { success: true, agentActivity: { id: variables.input.id } } };
    } else if (query.includes('agentActivity(id:')) {
      const post = this.posts.find((p) => p.id === variables.id);
      data = { agentActivity: post ? { id: post.id, agentSession: { id: post.agentSessionId } } : null };
    } else if (query.includes('externalLinks')) data = { agentSession: { appUser: { id: install.appUserId }, externalLinks: this.links.map((url) => ({ url })) } };
    else if (query.includes('agentSessionUpdate')) { this.links.push(variables.input.addedExternalUrls[0].url); data = { agentSessionUpdate: { success: true } }; }
    else if (query.includes('issueUpdate')) { this.issueState = 'started'; data = { issueUpdate: { success: true } }; }
    else if (query.includes('issue(id:')) data = { issue: { id: variables.id, delegate: this.issueDelegate ? { id: this.issueDelegate } : null, state: { type: this.issueState }, team: { states: { nodes: [{ id: 'started-state', type: 'started', position: 1 }] } } } };
    else data = { agentSession: { id: variables.id, appUser: { id: install.appUserId }, activities: { nodes: this.posts.map((p) => ({ id: p.id, content: p.content, createdAt: new Date().toISOString() })) } } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
}

export async function seedLinear(home: string, fake = new FakeLinear()) {
  await writeAgentConfigs(home, [{ id: 'scout', provider: { kind: 'codex-cli', model: 'gpt-5.5', reasoningEffort: 'high', env: {} }, slack: {} }] as unknown as Parameters<typeof writeAgentConfigs>[1]);
  const agentStore = new AgentStore('scout');
  await agentStore.update((agent) => ({ ...agent, linear: { connected: true, clientId: install.clientId, organizationId: install.organizationId, appUserId: install.appUserId } }));
  const store = new LinearStore('scout');
  await store.update((file) => ({ ...file, installation: { ...install } }));
  const identity = new LinearIdentityService('scout', new LinearClient(fake.fetch), store);
  return { fake, identity, service: new LinearSessionService(identity), store, agentStore };
}
