import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { DASHBOARD_AUTH_GUARD_MARKER } from './dashboard-auth.js';

/**
 * Read-only runtime (issue #524).
 *
 * A runtime can satisfy every property of our isolated-runtime definition — its
 * own ANIMA_HOME, an app id no live agent holds, no bot token, no subscriber, no
 * provider loaded — and still mutate machine-scoped state that every live agent
 * depends on. Those properties all answer *"what does this runtime connect to?"*.
 * None answers *"what can this runtime do?"*.
 *
 * Connection isolation is not capability isolation. Isolation is of the home, not
 * of the machine: provider binaries on PATH, locks under ~/.cache/anima/**, the
 * machine user's Keychain, OS service-manager labels — all of them cross the
 * ANIMA_HOME boundary.
 *
 * `read-only` is a property, not a use. A property can be checked; a use cannot.
 * That is why this is not called "preview mode".
 *
 * ENFORCEMENT LIVES HERE, AT THE ROUTE LAYER, AND NOWHERE ELSE.
 * The dashboard may reflect the mode honestly (a disabled control that says why),
 * but the UI is not the enforcement point. A hidden button is theater: the route
 * is still mounted and `curl` still reaches it.
 *
 * A rule enforced by prose fails silently. A rule enforced by a 403 fails red.
 */

export const READ_ONLY_ENV = 'ANIMA_READ_ONLY';

/** The refusal is never bare. A refusal that cannot say why it refused gets read as a bug and routed around. */
export const READ_ONLY_REFUSAL = 'read-only runtime: machine-scoped mutation disabled';

export interface GovernedRoute {
  /** Stable id, used in the refusal body and in tests. */
  readonly id: string;
  readonly method: 'GET' | 'POST';
  /** Matched against the pathname only (query string stripped). */
  readonly pattern: RegExp;
  /**
   * WHY this route is machine-scoped. This is evidence read out of the code, not
   * a guess. Guessing a list manufactures exactly the "looks contained" illusion
   * this mode exists to remove.
   */
  readonly evidence: string;
}

/**
 * The governed set.
 *
 * Selection criterion: **the route mutates state that lives outside ANIMA_HOME and
 * is shared by every process owned by this machine user.**
 *
 * Note carefully what the criterion is NOT. It is not "the route takes the
 * machine-wide advisory lease", and it is not "the route is a POST". The lease
 * proves machine scope where it is taken; its *absence* proves nothing. The two
 * provider-usage GETs below take no lease and are not POSTs, and they rewrite the
 * machine user's OAuth credentials.
 *
 * Cross-checked against Milo's source-first capability inventory
 * (anima-team @ bb0e7ad). Applying the property above independently reproduced his
 * seven. `POST /api/agents/:agentId/home` was CONSIDERED AND EXCLUDED:
 * ensureExistingAgentHome() only stats the path and throws unless it is already a
 * directory. It validates; it does not create. Over-blocking is also a failure —
 * a guard that refuses more than it can justify teaches people to route around it.
 *
 * Still the *proven* set, not the *complete* one, and the difference is the whole
 * point of the mode.
 */
export const GOVERNED_ROUTES: readonly GovernedRoute[] = [
  {
    id: 'POST /api/provider-cli-status/:provider/apply',
    method: 'POST',
    pattern: /^\/api\/provider-cli-status\/[^/]+\/apply$/,
    evidence:
      'Installs a provider CLI binary. Provider binaries are shared by every Anima process owned by this machine user, even across different ANIMA_HOME values — server/provider-cli/launch-gate.ts acquires a machine-wide advisory lease under ~/.cache/anima/ for exactly that reason. A home-scoped operation would not need a machine-wide lease.',
  },
  {
    id: 'POST /api/system-update/apply',
    method: 'POST',
    pattern: /^\/api\/system-update\/apply$/,
    evidence:
      'Replaces the installed Anima runtime for this machine user, then respawns. Every live agent runs the installed build, not this process.',
  },
  {
    id: 'POST /api/services/restart',
    method: 'POST',
    pattern: /^\/api\/services\/restart$/,
    evidence:
      'Restarts OS service-manager labels owned by this machine user, terminating live agent processes this runtime does not own.',
  },
  {
    id: 'GET /api/provider-usage',
    method: 'GET',
    pattern: /^\/api\/provider-usage$/,
    evidence:
      'Reads provider usage, and on an expiring token performs an OAuth refresh and WRITES THE CREDENTIALS BACK — to ~/.claude/.credentials.json or to the machine user\'s Keychain via `security add-generic-password` (server/provider-usage/providers/claude.ts, and the same shape in codex.ts). The response may rotate the refresh token. That credential is outside ANIMA_HOME and is shared by every live agent. A GET with a machine-scoped write is still a machine-scoped write.',
  },
  {
    id: 'GET /api/provider-usage/:provider',
    method: 'GET',
    pattern: /^\/api\/provider-usage\/[^/]+$/,
    evidence:
      'Same credential refresh-and-write path as GET /api/provider-usage, for a single provider.',
  },
  {
    id: 'POST /api/filesystem/mkdir',
    method: 'POST',
    pattern: /^\/api\/filesystem\/mkdir$/,
    evidence:
      'Creates a directory at a caller-supplied host path. server/kb/kb.service.ts createKbDirectory() roots at realpath(homedir()) — the MACHINE USER\'s home, not ANIMA_HOME — and expands the requested parent under it. A read-only runtime must not write directories into the operator\'s home.',
  },
  {
    id: 'POST /api/agents',
    method: 'POST',
    pattern: /^\/api\/agents$/,
    evidence:
      'Materializes an agent home at a caller-supplied host path: createAgent() honors an explicit homePath "as-is", then ensureCreateAgentHome(), writeSeedMemory(), and mkdir(<home>/notes). Those files land outside ANIMA_HOME, on the machine the operator shares.',
  },
];

export function isReadOnlyRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[READ_ONLY_ENV];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function pathnameOf(url: string): string {
  const queryAt = url.indexOf('?');
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

/**
 * Fastify serves HEAD for every GET route, and a HEAD still runs the handler — so
 * a HEAD on a governed GET would still refresh and rewrite the credential.
 */
function normalizeMethod(method: string): string {
  return method === 'HEAD' ? 'GET' : method;
}

/** Pure, so the table can be tested without standing up a server. */
export function governedRouteFor(method: string, url: string): GovernedRoute | undefined {
  const wanted = normalizeMethod(method.toUpperCase());
  const pathname = pathnameOf(url);
  return GOVERNED_ROUTES.find((route) => route.method === wanted && route.pattern.test(pathname));
}

export interface ReadOnlyGuardOptions {
  /** Defaults to the ANIMA_READ_ONLY environment variable. Injectable for tests. */
  readonly readOnly?: boolean;
}

/**
 * Register AFTER `registerDashboardAuthGuard`, and before any route.
 *
 * This is a `preHandler`, not an `onRequest`, and the distinction is load-bearing.
 * Dashboard auth checks at `preHandler`; `onRequest` runs strictly earlier. A
 * read-only guard on `onRequest` would answer an UNAUTHENTICATED governed request
 * with this detailed 403 — leaking the route inventory and its evidence to a caller
 * who was never entitled to a reply, and quietly replacing the `401
 * authentication_required` contract.
 *
 * Same-type hooks run in registration order, so auth answers first (401), and only
 * an authenticated caller reaches the read-only refusal (403). Both still run ahead
 * of the handler, so the governed handler never executes: the refusal remains a
 * closed door, not a late abort inside one.
 */
export function registerReadOnlyGuard(fastify: FastifyInstance, options: ReadOnlyGuardOptions = {}): void {
  // The ordering above is a CONTRACT, so it is checked, not documented. If the read-only
  // guard is registered before the dashboard auth guard, its hook runs first and answers
  // an unauthenticated governed request with the detailed 403 — leaking the governed route
  // inventory to a caller with no credentials. That reorder is a one-line edit in app.ts
  // and every request-level test would stay green, because both guards still "work".
  //
  // So it fails at BOOT instead: the server does not start. An ordering bug that can only
  // be caught by remembering to look for it will eventually not be looked for.
  if (!fastify.hasDecorator(DASHBOARD_AUTH_GUARD_MARKER)) {
    throw new Error(
      'registerReadOnlyGuard must be registered AFTER registerDashboardAuthGuard: ' +
        'same-type hooks run in registration order, and read-only must not preempt authentication.',
    );
  }

  const readOnly = options.readOnly ?? isReadOnlyRuntime();
  // Nothing to enforce when the runtime is writable. The check above still ran: the ordering
  // contract holds whether or not the mode is on, so it cannot rot while read-only is off.
  if (!readOnly) return;

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const governed = governedRouteFor(request.method, request.url);
    if (!governed) return;

    return reply.status(403).send({
      error: READ_ONLY_REFUSAL,
      reason: governed.evidence,
      route: governed.id,
      readOnly: true,
    });
  });
}
