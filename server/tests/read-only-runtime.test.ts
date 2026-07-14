import test from 'node:test';
import assert from 'node:assert/strict';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import {
  GOVERNED_ROUTES,
  READ_ONLY_REFUSAL,
  governedRouteFor,
  isReadOnlyRuntime,
  registerReadOnlyGuard,
} from '../web/read-only.js';
import { registerDashboardAuthGuard } from '../web/dashboard-auth.js';
import type { DashboardAuthService } from '../settings/dashboard-auth.service.js';
import { registerAgentRoutes } from '../web/agent-routes.js';
import { registerKbRoutes } from '../web/kb-routes.js';
import { registerSystemRoutes } from '../web/system-routes.js';

/**
 * Read-only runtime (issue #524).
 *
 * ── THE RULE THIS FILE OBEYS ──────────────────────────────────────────────────
 * NO test in this file may execute a real governed handler.
 *
 * The governed handlers refresh OAuth credentials, install provider binaries,
 * replace the runtime, restart OS services, and create host directories. If a test
 * mounts them and the guard regresses, then THE TEST'S RED PATH PERFORMS THE EXACT
 * ACTION THE GUARD EXISTS TO PREVENT. A safety test must be able to fail without
 * committing the disaster it is testing for.
 *
 * The first version of this file did mount them, on the reasoning that "the guard
 * short-circuits before the handler runs" — which assumes the correctness of the
 * very thing under test. A test that is only safe when the code is already right
 * provides no safety at all. (Caught by @milo on #532.)
 *
 * So: every request-executing test uses INERT handlers. Real routes are ENUMERATED
 * (via `onRoute`, which never invokes anything) but never INVOKED.
 *
 * ── BOTH CONTROLS ─────────────────────────────────────────────────────────────
 *   negative — a governed route MUST 403. Proves the guard can fire.
 *   positive — an ungoverned route MUST still pass while ON, and governed routes
 *              MUST reach the handler while OFF. Proves the guard is a ruler, not
 *              a wall. Without this, a guard that 403s everything passes perfectly.
 */

const INERT = { reached: 'handler' } as const;

function pathOf(route: { id: string }): string {
  return route.id.slice(route.id.indexOf(' ') + 1);
}

function concretePathOf(route: { id: string }): string {
  return pathOf(route).replace(':provider', 'claude-code');
}

function fakeAuth(authenticated: boolean): DashboardAuthService {
  return {
    isRequestAuthenticated: async () => authenticated,
  } as unknown as DashboardAuthService;
}

/**
 * Every governed route, mounted with an INERT handler. Used by every test that
 * actually issues a request. Nothing here can touch the machine, so the guard is
 * free to regress and the suite is free to go red.
 *
 * Auth is always registered, and always FIRST, exactly as `buildWebApp` does — a test
 * app that skips a production hook is testing a different program.
 */
function inertApp(readOnly: boolean, authenticated = true): FastifyInstance {
  const fastify = Fastify({ logger: false });
  registerDashboardAuthGuard(fastify, fakeAuth(authenticated));
  registerReadOnlyGuard(fastify, { readOnly });

  for (const route of GOVERNED_ROUTES) {
    fastify.route({ method: route.method, url: pathOf(route), handler: async () => INERT });
  }
  // An ungoverned route, for the positive control.
  fastify.get('/api/health', async () => ({ ok: true }));
  return fastify;
}

/** The real route modules — ENUMERATED ONLY, never invoked. */
function registerGovernedRouteModules(fastify: FastifyInstance): void {
  registerSystemRoutes(fastify);
  registerKbRoutes(fastify);
  registerAgentRoutes(fastify);
}

/**
 * The bridge between the inert tests and reality: every governed id must name a
 * route that is actually mounted by the real app.
 *
 * A table that governs a route which does not exist governs nothing — and looks
 * exactly like a table that governs everything. This is what keeps the inert tests
 * honest when the real routes move underneath them.
 *
 * `onRoute` fires at registration and hands us (method, url). It executes no
 * handler, so this stays safe. NOT printRoutes(), which renders a prefix TREE —
 * nested paths never appear as whole strings there, so a substring assertion
 * against it reds on the instrument rather than the code.
 */
test('#524 every governed id maps to a really-mounted route (enumeration only, no handler runs)', async () => {
  const fastify = Fastify({ logger: false });
  const mounted = new Set<string>();
  fastify.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) mounted.add(`${method} ${route.url}`);
  });
  registerGovernedRouteModules(fastify);
  await fastify.ready();

  for (const route of GOVERNED_ROUTES) {
    assert.ok(
      mounted.has(route.id),
      `governed route ${route.id} is not mounted by the real app — the table is stale, and a stale table refuses nothing`,
    );
  }

  // Fastify auto-registers HEAD for every GET, and a HEAD runs the GET handler.
  assert.ok(mounted.has('HEAD /api/provider-usage'), 'HEAD is auto-registered for the governed GET');

  await fastify.close();
});

/** NEGATIVE CONTROL. */
test('#524 read-only ON: every governed route is refused 403 with a readable reason', async () => {
  const fastify = inertApp(true);
  await fastify.ready();

  for (const route of GOVERNED_ROUTES) {
    const response = await fastify.inject({ method: route.method, url: concretePathOf(route) });

    assert.equal(response.statusCode, 403, `${route.id} must be refused in a read-only runtime`);

    const body = response.json() as { error?: string; reason?: string; route?: string; readOnly?: boolean };
    assert.equal(body.error, READ_ONLY_REFUSAL);
    assert.equal(body.route, route.id);
    assert.equal(body.readOnly, true);
    // Never a bare 403. A refusal that cannot say why it refused gets treated as a
    // bug and routed around by the next person.
    assert.ok(typeof body.reason === 'string' && body.reason.length > 0, `${route.id} refused without a reason`);
  }

  await fastify.close();
});

test('#524 read-only ON: HEAD on a governed GET is refused too', async () => {
  const fastify = inertApp(true);
  await fastify.ready();
  const response = await fastify.inject({ method: 'HEAD', url: '/api/provider-usage' });
  assert.equal(response.statusCode, 403);
  await fastify.close();
});

/** POSITIVE CONTROL 1: the guard is a ruler, not a wall. */
test('#524 read-only ON: an ungoverned route still succeeds', async () => {
  const fastify = inertApp(true);
  await fastify.ready();
  const response = await fastify.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200, 'read-only must not refuse ungoverned routes');
  assert.deepEqual(response.json(), { ok: true });
  await fastify.close();
});

/** POSITIVE CONTROL 2: the guard is mode-conditioned, not always-on. */
test('#524 read-only OFF: governed routes reach their handler', async () => {
  const fastify = inertApp(false);
  await fastify.ready();

  for (const route of GOVERNED_ROUTES) {
    const response = await fastify.inject({ method: route.method, url: concretePathOf(route) });
    assert.equal(response.statusCode, 200, `${route.id} must NOT be refused when read-only is off`);
    assert.deepEqual(response.json(), INERT);
  }

  await fastify.close();
});

/**
 * TWO-SIDED AUTH CONTROL.
 *
 * The read-only guard must not preempt dashboard auth. Auth checks at `preHandler`;
 * an `onRequest` guard runs strictly earlier and would answer an UNAUTHENTICATED
 * governed request with the detailed read-only 403 — leaking the governed route
 * inventory and its evidence to a caller who was never entitled to a reply, and
 * silently replacing the `401 authentication_required` contract.
 *
 * Both sides are required. Asserting only the 401 would pass for a guard that never
 * fires at all. (Caught by @milo on #532.)
 */
test('#524 read-only + dashboard auth: unauthenticated governed request stays 401, and does not leak the refusal', async () => {
  const fastify = inertApp(true, false);
  await fastify.ready();

  for (const route of GOVERNED_ROUTES) {
    const response = await fastify.inject({ method: route.method, url: concretePathOf(route) });

    assert.equal(response.statusCode, 401, `${route.id} must answer 401 before the read-only refusal`);
    assert.deepEqual(response.json(), { error: 'authentication_required' });

    // The refusal carries the route inventory and the evidence for why it is
    // machine-scoped. An unauthenticated caller must not receive any of it.
    assert.doesNotMatch(response.body, /read-only runtime/i, 'the refusal leaked to an unauthenticated caller');
  }

  await fastify.close();
});

test('#524 read-only + dashboard auth: authenticated governed request gets the readable 403', async () => {
  const fastify = inertApp(true, true);
  await fastify.ready();

  for (const route of GOVERNED_ROUTES) {
    const response = await fastify.inject({ method: route.method, url: concretePathOf(route) });
    assert.equal(response.statusCode, 403, `${route.id} must be refused once authenticated`);
    const body = response.json() as { error?: string; reason?: string };
    assert.equal(body.error, READ_ONLY_REFUSAL);
    assert.ok(typeof body.reason === 'string' && body.reason.length > 0);
  }

  await fastify.close();
});

/**
 * THE ORDERING CONTRACT, pinned where it actually lives.
 *
 * The two tests above build their own app, so they prove the guard BEHAVES correctly
 * when registered in the right order. They cannot prove `buildWebApp` registers it in
 * that order — swap the two lines in app.ts and every request-level test still passes,
 * because both guards still work; only their sequence is wrong. A test that mirrors
 * production ordering is not a test OF production ordering.
 *
 * So the contract is enforced at registration and fails at boot. Nothing to remember.
 */
test('#524 registering the read-only guard before the auth guard fails at boot, not at request time', () => {
  const fastify = Fastify({ logger: false });
  assert.throws(
    () => registerReadOnlyGuard(fastify, { readOnly: true }),
    /must be registered AFTER registerDashboardAuthGuard/,
    'a read-only guard ahead of auth would answer unauthenticated callers with the refusal',
  );
});

test('#524 the ordering precondition holds even when read-only is OFF', () => {
  // Otherwise the contract only exists in the mode nobody runs yet, and rots in the
  // mode everybody runs. The check must not sit behind the feature flag.
  const fastify = Fastify({ logger: false });
  assert.throws(() => registerReadOnlyGuard(fastify, { readOnly: false }), /must be registered AFTER/);
});

test('#524 buildWebApp registers the guards in the order the contract requires', async () => {
  // If app.ts ever puts read-only first, this throws during construction — no request
  // is issued, so no handler runs, so this stays safe to run.
  const { buildWebApp } = await import('../web/app.js');
  assert.doesNotThrow(() => buildWebApp().close());
});

test('#524 the governed table matches on method and path, and ignores the query string', () => {
  assert.ok(governedRouteFor('POST', '/api/services/restart'));
  assert.ok(governedRouteFor('GET', '/api/provider-usage'));
  assert.ok(governedRouteFor('GET', '/api/provider-usage?refresh=1'));
  assert.ok(governedRouteFor('GET', '/api/provider-usage/claude-code'));
  assert.ok(governedRouteFor('HEAD', '/api/provider-usage'), 'HEAD must normalize to GET');
  assert.ok(governedRouteFor('POST', '/api/provider-cli-status/claude-code/apply'));

  // Host-path writers, proven in Milo's inventory and re-derived from the property.
  assert.ok(governedRouteFor('POST', '/api/filesystem/mkdir'));
  assert.ok(governedRouteFor('POST', '/api/agents'));

  // Ungoverned: reads that do not cross the ANIMA_HOME boundary.
  assert.equal(governedRouteFor('GET', '/api/health'), undefined);
  assert.equal(governedRouteFor('GET', '/api/server-info'), undefined);
  assert.equal(governedRouteFor('GET', '/api/system-update'), undefined);
  assert.equal(governedRouteFor('GET', '/api/provider-cli-status'), undefined);
  // The `check` routes take no machine-wide lease and write nothing.
  assert.equal(governedRouteFor('POST', '/api/provider-cli-status/claude-code/check'), undefined);
  // Method matters: the governed set is not "every POST".
  assert.equal(governedRouteFor('POST', '/api/provider-usage'), undefined);

  // CONSIDERED AND EXCLUDED: ensureExistingAgentHome() stats the path and throws
  // unless it is already a directory. It validates; it does not create. Over-blocking
  // is a failure too — a guard that refuses more than it can justify gets routed around.
  assert.equal(governedRouteFor('POST', '/api/agents/nora/home'), undefined);
  assert.equal(governedRouteFor('GET', '/api/agents'), undefined);
});

test('#524 ANIMA_READ_ONLY parsing: default off, explicit on', () => {
  assert.equal(isReadOnlyRuntime({}), false);
  assert.equal(isReadOnlyRuntime({ ANIMA_READ_ONLY: '' }), false);
  assert.equal(isReadOnlyRuntime({ ANIMA_READ_ONLY: '0' }), false);
  assert.equal(isReadOnlyRuntime({ ANIMA_READ_ONLY: 'false' }), false);
  assert.equal(isReadOnlyRuntime({ ANIMA_READ_ONLY: '1' }), true);
  assert.equal(isReadOnlyRuntime({ ANIMA_READ_ONLY: 'true' }), true);
  assert.equal(isReadOnlyRuntime({ ANIMA_READ_ONLY: 'TRUE' }), true);
  assert.equal(isReadOnlyRuntime({ ANIMA_READ_ONLY: ' on ' }), true);
});

/**
 * The GET that started this. Kept as a test so it cannot quietly drop out of the
 * governed set: GET /api/provider-usage performs an OAuth refresh and writes the
 * credential back to ~/.claude/.credentials.json or the machine user's Keychain.
 * It is a GET, it takes no machine-wide lease, and it mutates machine-scoped state.
 */
test('#524 the credential-writing GETs are governed (machine scope is not "is a POST", and not "takes the lease")', () => {
  const usage = governedRouteFor('GET', '/api/provider-usage');
  assert.ok(usage, 'GET /api/provider-usage rewrites machine-user OAuth credentials and must be governed');
  assert.match(usage.evidence, /credential/i);

  const perProvider = governedRouteFor('GET', '/api/provider-usage/claude-code');
  assert.ok(perProvider, 'the per-provider usage GET has the same refresh-and-write path');
});
