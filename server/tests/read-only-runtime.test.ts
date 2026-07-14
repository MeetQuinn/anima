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
import { registerSystemRoutes } from '../web/system-routes.js';

/**
 * Read-only runtime (issue #524).
 *
 * These tests carry BOTH controls, deliberately.
 *
 *   negative control — a governed route MUST 403 when read-only is on.
 *                      Proves the guard can fire at all.
 *   positive control — an ungoverned route MUST still succeed when read-only
 *                      is on, and a governed route MUST reach its handler when
 *                      read-only is OFF.
 *                      Proves the guard is a ruler and not a wall.
 *
 * Without the positive control, a guard that 403s *every* request passes the
 * negative control perfectly. A dead instrument and a perfect one look identical.
 */

/** Real system routes behind the real guard. Never `listen`, so nothing can escape to the machine. */
function appWithGuard(readOnly: boolean): FastifyInstance {
  const fastify = Fastify({ logger: false });
  registerReadOnlyGuard(fastify, { readOnly });
  registerSystemRoutes(fastify);
  return fastify;
}

/**
 * A stand-in for the governed routes, used ONLY for the read-only-OFF control.
 *
 * The off-path must prove the guard does not fire — but proving that against the
 * real handlers would mean actually restarting services and upgrading the provider
 * CLI on this machine. So the off-path asserts against stubs, and the on-path
 * asserts against the real routes (safe, because the guard short-circuits before
 * the handler runs). The seam between them is `governedRouteFor`, tested pure below.
 */
function stubAppWithGuard(readOnly: boolean): FastifyInstance {
  const fastify = Fastify({ logger: false });
  registerReadOnlyGuard(fastify, { readOnly });
  for (const route of GOVERNED_ROUTES) {
    const path = route.id.slice(route.id.indexOf(' ') + 1);
    fastify.route({
      method: route.method,
      url: path,
      handler: async () => ({ reached: 'handler' }),
    });
  }
  return fastify;
}

/**
 * Every governed id must be a real, currently-mounted route.
 *
 * A table that governs a route which does not exist governs nothing — and it looks
 * exactly like a table that governs everything. This is the check that keeps the
 * governed set honest when the routes move underneath it.
 *
 * Collected via the `onRoute` hook (exact: method + url as registered). NOT via
 * printRoutes, which renders a prefix *tree* — nested paths never appear as whole
 * strings there, so a substring assertion against it reports a red that is about
 * the instrument and not about the code.
 */
test('#524 every governed route id is actually mounted by the real system routes', async () => {
  const fastify = Fastify({ logger: false });
  const mounted = new Set<string>();
  fastify.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) mounted.add(`${method} ${route.url}`);
  });
  registerSystemRoutes(fastify);
  await fastify.ready();

  for (const route of GOVERNED_ROUTES) {
    assert.ok(
      mounted.has(route.id),
      `governed route ${route.id} is not mounted by registerSystemRoutes — the table is stale, and a stale table refuses nothing`,
    );
  }

  // Fastify auto-registers HEAD for every GET, and a HEAD runs the GET handler.
  // If this ever stops being true the HEAD normalization becomes dead code, and
  // dead code that guards a credential write should fail loudly, not quietly.
  assert.ok(mounted.has('HEAD /api/provider-usage'), 'HEAD is auto-registered for the governed GET');

  await fastify.close();
});

/** NEGATIVE CONTROL: the guard must fire on every governed route, against the real handlers. */
test('#524 read-only ON: every governed route is refused 403 with a readable reason', async () => {
  const fastify = appWithGuard(true);
  await fastify.ready();

  for (const route of GOVERNED_ROUTES) {
    const path = route.id
      .slice(route.id.indexOf(' ') + 1)
      .replace(':provider', 'claude-code');

    const response = await fastify.inject({ method: route.method, url: path });

    assert.equal(response.statusCode, 403, `${route.id} must be refused in a read-only runtime`);

    const body = response.json() as { error?: string; reason?: string; route?: string; readOnly?: boolean };
    assert.equal(body.error, READ_ONLY_REFUSAL);
    assert.equal(body.route, route.id);
    assert.equal(body.readOnly, true);
    // Never a bare 403. A refusal that cannot say why it refused gets treated as a
    // bug and routed around by the next person.
    assert.ok(
      typeof body.reason === 'string' && body.reason.length > 0,
      `${route.id} refused without a reason`,
    );
  }

  await fastify.close();
});

/** HEAD runs the GET handler. A HEAD on a governed GET would still refresh and rewrite the credential. */
test('#524 read-only ON: HEAD on a governed GET is refused too', async () => {
  const fastify = appWithGuard(true);
  await fastify.ready();
  const response = await fastify.inject({ method: 'HEAD', url: '/api/provider-usage' });
  assert.equal(response.statusCode, 403);
  await fastify.close();
});

/**
 * POSITIVE CONTROL 1: an ungoverned route must still work while read-only is ON.
 * If this goes red, the guard is refusing everything — which would make the
 * negative control above pass for the wrong reason.
 */
test('#524 read-only ON: an ungoverned route still succeeds (the guard is a ruler, not a wall)', async () => {
  const fastify = appWithGuard(true);
  await fastify.ready();
  const response = await fastify.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200, 'read-only must not refuse ungoverned routes');
  assert.deepEqual(response.json(), { ok: true });
  await fastify.close();
});

/**
 * POSITIVE CONTROL 2: with read-only OFF, the governed routes must reach their
 * handler. If this goes red, the guard is always-on — and "always refuses" is
 * indistinguishable from "correctly refuses" if you only ever test the refusal.
 */
test('#524 read-only OFF: governed routes reach their handler (the guard is mode-conditioned)', async () => {
  const fastify = stubAppWithGuard(false);
  await fastify.ready();

  for (const route of GOVERNED_ROUTES) {
    const path = route.id
      .slice(route.id.indexOf(' ') + 1)
      .replace(':provider', 'claude-code');
    const response = await fastify.inject({ method: route.method, url: path });
    assert.equal(response.statusCode, 200, `${route.id} must NOT be refused when read-only is off`);
    assert.deepEqual(response.json(), { reached: 'handler' });
  }

  await fastify.close();
});

test('#524 the governed table matches on method and path, and ignores the query string', () => {
  assert.ok(governedRouteFor('POST', '/api/services/restart'));
  assert.ok(governedRouteFor('GET', '/api/provider-usage'));
  assert.ok(governedRouteFor('GET', '/api/provider-usage?refresh=1'));
  assert.ok(governedRouteFor('GET', '/api/provider-usage/claude-code'));
  assert.ok(governedRouteFor('HEAD', '/api/provider-usage'), 'HEAD must normalize to GET');
  assert.ok(governedRouteFor('POST', '/api/provider-cli-status/claude-code/apply'));

  // Ungoverned: reads that do not cross the ANIMA_HOME boundary.
  assert.equal(governedRouteFor('GET', '/api/health'), undefined);
  assert.equal(governedRouteFor('GET', '/api/server-info'), undefined);
  assert.equal(governedRouteFor('GET', '/api/system-update'), undefined);
  assert.equal(governedRouteFor('GET', '/api/provider-cli-status'), undefined);
  // The `check` routes take no machine-wide lease and write nothing.
  assert.equal(governedRouteFor('POST', '/api/provider-cli-status/claude-code/check'), undefined);
  // Method matters: the governed set is not "every POST".
  assert.equal(governedRouteFor('POST', '/api/provider-usage'), undefined);
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
 * The GET that started this. Documented as a test so it cannot quietly drop out of
 * the governed set: GET /api/provider-usage performs an OAuth refresh and writes the
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
