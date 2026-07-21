import test from 'node:test';
import assert from 'node:assert/strict';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import {
  GOVERNED_ROUTES,
  MACHINE_WRITE_HEADER,
  READ_ONLY_REFUSAL,
  allowsMachineWrites,
  governedRouteFor,
  isReadOnlyRuntime,
  registerReadOnlyGuard,
  resolveMachineWriteMode,
} from '../web/read-only.js';
import { registerDashboardAuthGuard } from '../web/dashboard-auth.js';
import type { DashboardAuthService } from '../settings/dashboard-auth.service.js';
import { registerAgentRoutes } from '../web/agent-routes.js';
import { registerKbRoutes } from '../web/kb-routes.js';
import { registerSystemRoutes } from '../web/system-routes.js';
import { registerErrorHandler } from '../web/http.js';
import { KbError } from '../kb/kb.helper.js';

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
interface InertOptions {
  readonly allowMachineWrites?: boolean;
  /** Collected, not printed: a warning nobody can observe is a warning nobody can test. */
  readonly warnings?: string[];
}

function inertApp(readOnly: boolean, authenticated = true, extra: InertOptions = {}): FastifyInstance {
  const fastify = Fastify({ logger: false });
  // The real error handler, because one of the claims below is precisely that the mode
  // header survives an error rendered by it. A hand-rolled stand-in would prove nothing.
  registerErrorHandler(fastify);
  registerDashboardAuthGuard(fastify, fakeAuth(authenticated));
  registerReadOnlyGuard(fastify, {
    readOnly,
    allowMachineWrites: extra.allowMachineWrites ?? false,
    warn: (message) => extra.warnings?.push(message),
  });

  for (const route of GOVERNED_ROUTES) {
    fastify.route({ method: route.method, url: pathOf(route), handler: async () => INERT });
  }
  // An ungoverned route, for the positive control.
  fastify.get('/api/health', async () => ({ ok: true }));
  return fastify;
}

/**
 * The SAFE PROBE, in miniature.
 *
 * The real `POST /api/filesystem/mkdir` with a nonexistent parent throws `KbError(404,
 * 'path_not_found')` from `realpath()` BEFORE it writes anything — which is why it is the
 * route we probe an unproven guard with. This app reproduces that shape with an inert
 * handler that throws the same error, so the probe's contract can be tested without ever
 * calling the real one. (Probe a guard with the route whose red path is most harmless.
 * Never with the most dangerous one. — @iris, after I did exactly that.)
 */
function safeProbeApp(
  readOnly: boolean,
  allowMachineWrites: boolean,
  extra: { warnings?: string[]; authenticated?: boolean } = {},
): FastifyInstance {
  const fastify = Fastify({ logger: false });
  registerErrorHandler(fastify);
  registerDashboardAuthGuard(fastify, fakeAuth(extra.authenticated ?? true));
  registerReadOnlyGuard(fastify, {
    readOnly,
    allowMachineWrites,
    warn: (message) => extra.warnings?.push(message),
  });
  fastify.post('/api/filesystem/mkdir', async () => {
    throw new KbError(404, 'path_not_found');
  });
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
  assert.ok(governedRouteFor('PUT', '/api/provider-context-limits'));
  assert.ok(governedRouteFor('POST', '/api/provider-accounts/claude-code/select'));
  assert.ok(governedRouteFor('POST', '/api/provider-accounts/claude-code/login'));
  assert.ok(governedRouteFor('POST', '/api/provider-accounts/claude-code/login/op-1/code'));
  assert.ok(governedRouteFor('POST', '/api/provider-accounts/claude-code/login/op-1/cancel'));
  assert.equal(governedRouteFor('GET', '/api/provider-accounts/claude-code/login/op-1'), undefined);

  // Host-path writers, proven in Milo's inventory and re-derived from the property.
  assert.ok(governedRouteFor('POST', '/api/filesystem/mkdir'));
  assert.ok(governedRouteFor('POST', '/api/agents'));

  // Ungoverned: reads that do not cross the ANIMA_HOME boundary.
  assert.equal(governedRouteFor('GET', '/api/health'), undefined);
  assert.equal(governedRouteFor('GET', '/api/server-info'), undefined);
  assert.equal(governedRouteFor('GET', '/api/system-update'), undefined);
  assert.equal(governedRouteFor('GET', '/api/provider-cli-status'), undefined);
  assert.equal(
    governedRouteFor('GET', '/api/provider-context-limits'),
    undefined,
  );
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

/* ─────────────────────────────────────────────────────────────────────────────
 * CUT 2 (#524): the machine-write opt-in, MEANINGFUL BEFORE THE DEFAULT FLIPS.
 *
 * The migration order is: (1) ship the flag → (2) live sets it and is VERIFIED STILL
 * WORKING → (3) only then does unset flip from permit to refuse. Reversing 2 and 3
 * trades live for a correct default.
 *
 * But step 2 has a trap, and it is the same trap as everything else this week: if the
 * flag is a no-op until the flip, then "we verified live still works" is NECESSARILY
 * GREEN — the flag does nothing, so of course live works. That is a dead instrument
 * dressed up as a milestone. The flag must be OBSERVABLE ON DAY ONE, and observable
 * through the harmless probe, or step 2 is decorative.
 * ──────────────────────────────────────────────────────────────────────────── */

test('#524 machine-write mode: unset permits (for now) and says so; explicit permits; read-only refuses', () => {
  assert.equal(resolveMachineWriteMode({}), 'implicit-default');
  assert.equal(resolveMachineWriteMode({ ANIMA_ALLOW_MACHINE_WRITES: '1' }), 'explicit');
  assert.equal(resolveMachineWriteMode({ ANIMA_READ_ONLY: '1' }), 'refused');

  // A CONTRADICTION RESOLVES TOWARD REFUSAL. Both flags set is not a request to write
  // the machine; it is a misconfiguration. A guard that resolves ambiguity toward
  // permission is a guard you can talk out of refusing.
  assert.equal(resolveMachineWriteMode({ ANIMA_READ_ONLY: '1', ANIMA_ALLOW_MACHINE_WRITES: '1' }), 'refused');

  assert.equal(allowsMachineWrites({}), false);
  assert.equal(allowsMachineWrites({ ANIMA_ALLOW_MACHINE_WRITES: '0' }), false);
  assert.equal(allowsMachineWrites({ ANIMA_ALLOW_MACHINE_WRITES: 'false' }), false);
  assert.equal(allowsMachineWrites({ ANIMA_ALLOW_MACHINE_WRITES: ' TRUE ' }), true);
});

/**
 * THE CONTRADICTION, ASSERTED WHERE IT RUNS.
 *
 * The pure test above proves `resolveMachineWriteMode` resolves both-flags-set toward
 * refusal. It proves NOTHING about the guard, which is what a request actually hits. In
 * the first draft those were two separate copies of the precedence rule and only the
 * pure one was tested — mutation m6 flipped the guard's copy and every test stayed green
 * while a both-flags process happily wrote the machine.
 *
 * The rule now lives in exactly one function and the guard calls it. This test is the
 * proof that it is that function the request reaches, and not a second opinion.
 */
test('#524 a request to a both-flags-set runtime is REFUSED, not permitted', async () => {
  const fastify = inertApp(true, true, { allowMachineWrites: true });
  await fastify.ready();

  for (const route of GOVERNED_ROUTES) {
    const response = await fastify.inject({ method: route.method, url: concretePathOf(route) });
    assert.equal(response.statusCode, 403, `${route.id}: read-only must win over the machine-write opt-in`);
    assert.equal(response.headers[MACHINE_WRITE_HEADER], 'refused');
  }

  await fastify.close();
});

test('#524 the mode rides on every governed response that reaches the guard, so an authenticated caller can ask a machine what it is', async () => {
  const cases: ReadonlyArray<{ readOnly: boolean; allow: boolean; mode: string; status: number }> = [
    { readOnly: true, allow: false, mode: 'refused', status: 403 },
    { readOnly: false, allow: true, mode: 'explicit', status: 200 },
    { readOnly: false, allow: false, mode: 'implicit-default', status: 200 },
  ];

  for (const kase of cases) {
    const warnings: string[] = [];
    const fastify = inertApp(kase.readOnly, true, { allowMachineWrites: kase.allow, warnings });
    await fastify.ready();

    const response = await fastify.inject({ method: 'POST', url: '/api/services/restart' });
    assert.equal(response.statusCode, kase.status);
    assert.equal(
      response.headers[MACHINE_WRITE_HEADER],
      kase.mode,
      'a machine that cannot be asked which mode it is in gets ASSUMED to be in the safe one',
    );

    // The header is a claim about GOVERNED routes. Stamping it on everything would make
    // it meaningless — and would leak the mode to every caller of every public route.
    const ungoverned = await fastify.inject({ method: 'GET', url: '/api/health' });
    assert.equal(ungoverned.statusCode, 200);
    assert.equal(ungoverned.headers[MACHINE_WRITE_HEADER], undefined);

    await fastify.close();
  }
});

/**
 * THE HEADER'S REAL BOUNDARY: it rides responses that REACH THE GUARD, not "every
 * governed response". (@milo, HOLD on #536 — he reproduced the 401 independently.)
 *
 * Dashboard auth is a `preHandler` registered BEFORE the read-only guard, so an
 * unauthenticated governed request is answered `401` and the mode hook never runs. That
 * ordering is CORRECT and load-bearing (it is what stops the refusal leaking the route
 * inventory to a caller with no credentials) — so the header contract must be written to
 * match it, not the other way round.
 *
 * The consequence is the dangerous part, and it is why this is asserted rather than
 * mentioned: **an absent header is not a pass.** Unauthenticated, an older build, or a
 * typo'd path all print the same nothing — and that nothing is indistinguishable from a
 * healthy guard unless the verifier requires a POSITIVE read of `explicit`. "We didn't
 * see implicit-default" is what a guard that never ran also looks like.
 */
test('#524 the mode header is absent on 401 and present once authenticated — absence is NOT a pass', async () => {
  const unauthenticated = inertApp(false, false, { allowMachineWrites: true });
  await unauthenticated.ready();

  for (const route of GOVERNED_ROUTES) {
    const response = await unauthenticated.inject({ method: route.method, url: concretePathOf(route) });
    assert.equal(response.statusCode, 401, `${route.id}: auth answers first, by design`);
    assert.equal(
      response.headers[MACHINE_WRITE_HEADER],
      undefined,
      'the hook never ran, so there is no mode to report — a verifier must not read this as safe',
    );
  }
  await unauthenticated.close();

  // POSITIVE CONTROL. Without this, the assertion above would also pass for a build that
  // never sets the header at all — i.e. the exact failure it is meant to catch.
  const authenticated = inertApp(false, true, { allowMachineWrites: true });
  await authenticated.ready();
  for (const route of GOVERNED_ROUTES) {
    const response = await authenticated.inject({ method: route.method, url: concretePathOf(route) });
    assert.equal(response.headers[MACHINE_WRITE_HEADER], 'explicit', `${route.id}: reachable ⇒ the mode is reported`);
  }
  await authenticated.close();
});

/**
 * THE LOAD-BEARING TEST OF THIS CUT.
 *
 * The whole point of putting the mode in a HEADER rather than a body is that the header
 * survives the handler's OWN response — including its 404. That is what makes the mode
 * readable via the safe probe (`POST /api/filesystem/mkdir` at a nonexistent parent,
 * which 404s at `realpath()` before it writes anything): you learn whether a running
 * machine is opted in WITHOUT performing a single machine action.
 *
 * If Fastify dropped headers set in `preHandler` when the handler throws, the design
 * would be silently broken and the only way to read live's mode would be to make live
 * actually write — i.e. the exact thing the probe exists to avoid. So it is asserted,
 * against the REAL error handler, not assumed.
 */
test('#524 the mode header survives the handler own 404 — the safe probe can read it with zero machine action', async () => {
  for (const kase of [
    { allow: true, mode: 'explicit' },
    { allow: false, mode: 'implicit-default' },
  ]) {
    const fastify = safeProbeApp(false, kase.allow);
    await fastify.ready();

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/filesystem/mkdir',
      payload: { parent: '/nonexistent-anima-read-only-probe', name: 'probe' },
    });

    // The guard permitted; the handler refused on its own terms, before writing.
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: 'path_not_found' });
    assert.equal(
      response.headers[MACHINE_WRITE_HEADER],
      kase.mode,
      'the mode must ride out on the 404, or the only way to read it is to let the machine be written',
    );

    await fastify.close();
  }

  // And the same probe against a read-only process: 403, not 404. The 404 above is this
  // probe's POSITIVE control, not a freebie — a guard stuck at 403 would ace a 403-only
  // test. (@iris, lifting the default-deny.)
  const readOnly = safeProbeApp(true, false);
  await readOnly.ready();
  const refused = await readOnly.inject({
    method: 'POST',
    url: '/api/filesystem/mkdir',
    payload: { parent: '/nonexistent-anima-read-only-probe', name: 'probe' },
  });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.headers[MACHINE_WRITE_HEADER], 'refused');
  await readOnly.close();
});

/**
 * The census. Every warning here is a caller we must migrate BEFORE the default flips.
 *
 * This is the instrument step 2 of the migration actually runs on: it tells us who is
 * relying on the permission that is about to be taken away, while it is still free to
 * find out. Without it we would learn the answer from the incident.
 */
test('#524 implicit-default WARNS — the permission we are deleting is never granted silently', async () => {
  const warnings: string[] = [];
  const fastify = inertApp(false, true, { allowMachineWrites: false, warnings });
  await fastify.ready();

  await fastify.inject({ method: 'POST', url: '/api/services/restart' });
  assert.equal(warnings.length, 1, 'a machine write on an implicit default must not be silent');
  assert.match(warnings[0] ?? '', /IMPLICIT DEFAULT/);
  assert.match(warnings[0] ?? '', /POST \/api\/services\/restart/, 'the warning must name the caller to migrate');
  assert.match(warnings[0] ?? '', /ANIMA_ALLOW_MACHINE_WRITES/, 'and must say how to fix it');

  // Once per route: loud enough to find, bounded so it cannot become noise people learn
  // to scroll past. A warning that floods is a warning that gets filtered.
  await fastify.inject({ method: 'POST', url: '/api/services/restart' });
  assert.equal(warnings.length, 1, 'the same route must not re-warn');

  // But a DIFFERENT governed route is a different caller, and must be counted.
  await fastify.inject({ method: 'POST', url: '/api/agents' });
  assert.equal(warnings.length, 2);
  assert.match(warnings[1] ?? '', /POST \/api\/agents/);

  await fastify.close();
});

/**
 * THE WARNING MUST NOT CLAIM AN ACT IT CANNOT OBSERVE. (@milo, HOLD on #536.)
 *
 * It fires in `preHandler`, before the handler. My first draft said the process "wrote
 * machine-scoped state" — and @milo ran the safe probe at it: 404, nothing written, and
 * stderr announcing a write. **An instrument that overstates in the alarming direction
 * gets disbelieved, and then it is worth less than no instrument.** The next person who
 * sees it cry wolf on a harmless 404 stops reading it, and the census dies.
 *
 * The claim it CAN make is admission — true of every line it prints, and exactly the set
 * the flip will start refusing.
 */
test('#524 the implicit-default warning claims ADMISSION, not a write — it still fires on a 404 that wrote nothing', async () => {
  const warnings: string[] = [];
  const fastify = safeProbeApp(false, false, { warnings });
  await fastify.ready();

  const response = await fastify.inject({
    method: 'POST',
    url: '/api/filesystem/mkdir',
    payload: { parent: '/nonexistent-anima-read-only-probe', name: 'probe' },
  });

  // The handler refused on its own terms, before writing. NOTHING was written.
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: 'path_not_found' });

  // And the warning still fires — admission is what it counts, and this request WAS
  // admitted. It is a caller that the flip will start refusing.
  assert.equal(warnings.length, 1, 'the census counts admissions, so a 404 admission still counts');
  const warning = warnings[0] ?? '';
  assert.match(warning, /ADMITTED TO A MACHINE-SCOPED ROUTE/);

  // But it must NOT assert that a write happened, because on this exact request none did.
  assert.doesNotMatch(warning, /\bwrote\b/i, 'the hook cannot observe a write, so it must not claim one');
  assert.doesNotMatch(warning, /MACHINE WRITE PERMITTED/i, 'the original overstatement, kept red on purpose');

  await fastify.close();
});

test('#524 an explicitly opted-in runtime does NOT warn, and a read-only one does not either', async () => {
  const explicitWarnings: string[] = [];
  const explicit = inertApp(false, true, { allowMachineWrites: true, warnings: explicitWarnings });
  await explicit.ready();
  await explicit.inject({ method: 'POST', url: '/api/services/restart' });
  assert.deepEqual(explicitWarnings, [], 'a runtime that said what it wanted is not nagged');
  await explicit.close();

  // Positive control for the warning itself: a refusal is not a permitted write, so it
  // has nothing to warn about. Otherwise "warns" could just mean "warns always", and the
  // census above would be counting nothing.
  const refusedWarnings: string[] = [];
  const refused = inertApp(true, true, { allowMachineWrites: false, warnings: refusedWarnings });
  await refused.ready();
  const response = await refused.inject({ method: 'POST', url: '/api/services/restart' });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(refusedWarnings, [], 'a refused request performed no write, so there is nothing to warn about');
  await refused.close();
});

/**
 * The default sink, exercised. Everything above injects a `warn`, so all of it would
 * still pass if the real default wrote to nowhere — and a warning nobody can observe is
 * a warning nobody can test, which is the kind that turns out to have been silent all
 * along. This is the only test that runs the production sink.
 */
test('#524 the default warning sink really writes to stderr', async () => {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;

  try {
    const fastify = Fastify({ logger: false });
    registerDashboardAuthGuard(fastify, fakeAuth(true));
    // No `warn` injected: this is the production path.
    registerReadOnlyGuard(fastify, { readOnly: false, allowMachineWrites: false });
    fastify.post('/api/services/restart', async () => INERT);
    await fastify.ready();
    await fastify.inject({ method: 'POST', url: '/api/services/restart' });
    await fastify.close();
  } finally {
    process.stderr.write = original;
  }

  assert.ok(
    written.some((line) => line.includes('IMPLICIT DEFAULT') && line.includes('POST /api/services/restart')),
    'the implicit-default warning must reach stderr by default, not just when a test hands it a sink',
  );
});

/**
 * NOT IN THIS CUT: the flip.
 *
 * `ANIMA_ALLOW_MACHINE_WRITES` unset still PERMITS. This test exists to make that a
 * decision instead of an oversight — flipping it is a one-line change here plus one in
 * `resolveMachineWriteMode`, and this assertion will go red and tell the next person to
 * confirm live is opted in first. When live carries the flag and is verified working
 * (@totoday, on the live box — not from here), this is the test to invert.
 */
test('#524 the default is STILL permit — the flip waits on live carrying the flag', () => {
  assert.equal(
    resolveMachineWriteMode({}),
    'implicit-default',
    'if this went red, someone flipped the default: confirm LIVE sets ANIMA_ALLOW_MACHINE_WRITES first, or live 403s on its own credential refresh',
  );
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
