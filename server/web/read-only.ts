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
   *
   * It ships to the caller inside the 403, so it is part of the refusal's contract:
   * state the STABLE PROPERTY, never a current constant. A constant (a path, a
   * default, a root) is configuration; it goes stale, and worse, it invites the
   * reader to conclude the route is safe once the constant changes. The property is
   * what makes the route machine-scoped, and the property is what survives.
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
    id: 'POST /api/provider-accounts/claude-code/select',
    method: 'POST',
    pattern: /^\/api\/provider-accounts\/claude-code\/select$/,
    evidence:
      'Switches every Claude runtime to a different machine-user credential profile and creates shared-state links under the machine user\'s Claude configuration directories. Those directories and Keychain credentials live outside ANIMA_HOME and are shared with Claude Code processes this runtime does not own.',
  },
  {
    id: 'POST /api/provider-accounts/claude-code/login',
    method: 'POST',
    pattern: /^\/api\/provider-accounts\/claude-code\/login$/,
    evidence:
      'Starts Claude Code OAuth authentication in a machine-user credential profile. The subprocess writes Claude metadata and credentials outside ANIMA_HOME, including the machine user\'s service-keyed Keychain entry on macOS.',
  },
  {
    id: 'POST /api/provider-accounts/claude-code/login/:operationId/code',
    method: 'POST',
    pattern: /^\/api\/provider-accounts\/claude-code\/login\/[^/]+\/code$/,
    evidence:
      'Submits a one-time OAuth code to a live Claude authentication subprocess, which can persist machine-user credentials outside ANIMA_HOME and into the macOS Keychain.',
  },
  {
    id: 'POST /api/provider-accounts/claude-code/login/:operationId/cancel',
    method: 'POST',
    pattern: /^\/api\/provider-accounts\/claude-code\/login\/[^/]+\/cancel$/,
    evidence:
      'Terminates a live machine-user authentication subprocess whose in-progress OAuth flow and credential writes are outside ANIMA_HOME.',
  },
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
      'Reads provider usage, and on an expiring token performs an OAuth refresh and WRITES THE CREDENTIALS BACK — for every configured or discovered Claude account, into that account\'s own store: ~/.claude or an isolated ~/.claude-profiles/* credential file, or the machine user\'s Keychain via `security add-generic-password` under the account\'s service-keyed name (server/provider-usage/providers/claude.ts, and the same shape in codex.ts). The response may rotate the refresh token. That credential is outside ANIMA_HOME and is shared by every live agent. A GET with a machine-scoped write is still a machine-scoped write.',
  },
  {
    id: 'GET /api/provider-usage/:provider',
    method: 'GET',
    pattern: /^\/api\/provider-usage\/[^/]+$/,
    evidence:
      'Same credential refresh-and-write path as GET /api/provider-usage, for a single provider — restricted to the account the platform currently runs on.',
  },
  {
    id: 'POST /api/filesystem/mkdir',
    method: 'POST',
    pattern: /^\/api\/filesystem\/mkdir$/,
    evidence:
      'Creates a directory at a CALLER-SUPPLIED host path, outside ANIMA_HOME, on the filesystem this machine user shares (server/kb/kb.service.ts createKbDirectory()). The browse root bounds HOW FAR the caller may write; it does not decide WHETHER the write lands outside ANIMA_HOME, so the root\'s location is configuration, not exemption. Today that root is realpath(homedir()) — the machine user\'s home — but this route stays governed wherever the root points: a guard keyed on a knob is a guard a misconfigured runtime silently loses.',
  },
  {
    id: 'POST /api/agents',
    method: 'POST',
    pattern: /^\/api\/agents$/,
    evidence:
      'Materializes an agent home at a caller-supplied host path: createAgent() honors an explicit homePath "as-is", then ensureCreateAgentHome(), writeSeedMemory(), and mkdir(<home>/notes). Those files land outside ANIMA_HOME, on the machine the operator shares.',
  },
];

/**
 * The explicit machine-write opt-in (issue #524, cut 2).
 *
 * Today a runtime that forgets `ANIMA_READ_ONLY` gets full machine permissions. That
 * is a rule enforced by remembering, which is the same object as a rule enforced by
 * prose. The end state inverts it: refuse by default, and let a runtime that genuinely
 * must write the machine (live, which really does have to refresh credentials) say so.
 *
 * THE ORDER IS LOAD-BEARING AND CANNOT BE COMPRESSED:
 *   1. ship this flag, MEANINGFUL from day one            <- this cut
 *   2. live sets it, and is verified still working        <- a live action: totoday only
 *   3. only then does unset flip from "permit" to "refuse"
 * Doing 3 before 2 makes live start 403-ing on upgrade, and live is the one machine
 * that must write credentials. We would have traded live for a correct default.
 */
export const MACHINE_WRITE_ENV = 'ANIMA_ALLOW_MACHINE_WRITES';

/**
 * Rides on every governed-route response THAT REACHES THIS GUARD — including the
 * refusal and including the handler's own 4xx.
 *
 * ⚠️ THE QUALIFIER IS THE CONTRACT, NOT A FOOTNOTE. Dashboard auth is a `preHandler`
 * registered BEFORE this one, so an UNAUTHENTICATED governed request is answered `401`
 * and this hook never runs: no header. An older build that predates this cut: no header.
 * An ungoverned path: no header, by design.
 *
 * So an ABSENT header is not a pass and not a fail — it means the probe never reached
 * the guard. The only affirmative reading is the value itself. Anyone verifying a
 * machine must require that they positively READ `explicit`; "we didn't see
 * implicit-default" is the same nothing a dead guard prints. (@milo reproduced the 401
 * case on this PR; I had written "EVERY governed response", which was false.)
 *
 * Given that, the design still holds: the safe probe (`POST /api/filesystem/mkdir` at a
 * nonexistent parent, which 404s at `realpath()` before writing anything) carries the
 * header out on its 404, so an AUTHENTICATED caller can read a running machine's mode
 * with ZERO machine action. That is what step 2 needs: verify live is opted in, without
 * making live write.
 */
export const MACHINE_WRITE_HEADER = 'x-anima-machine-writes';

export type MachineWriteMode =
  /** ANIMA_READ_ONLY is on. Governed routes are refused 403. */
  | 'refused'
  /** Opted in on purpose. This is what live will carry. */
  | 'explicit'
  /**
   * Nobody said anything, so we permit — for now. This is the state we are trying to
   * delete, so it is never silent: it warns, and it is visible on the wire. If a
   * process we thought was safe is sitting in this state, we want to find out from an
   * instrument, not from an incident.
   */
  | 'implicit-default';

function envFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function isReadOnlyRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env[READ_ONLY_ENV]);
}

export function allowsMachineWrites(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env[MACHINE_WRITE_ENV]);
}

/**
 * Read-only WINS over the machine-write opt-in.
 *
 * Both set is a contradiction, and a guard that resolves a contradiction toward
 * permission is a guard you can talk out of refusing. Refusal is the safe reading, and
 * it is also the honest one: someone who set both did not mean "write the machine".
 */
export function machineWriteMode(readOnly: boolean, allowMachineWrites: boolean): MachineWriteMode {
  if (readOnly) return 'refused';
  if (allowMachineWrites) return 'explicit';
  return 'implicit-default';
}

/**
 * THE ONLY PLACE THIS PRECEDENCE IS WRITTEN.
 *
 * The first draft of this cut stated the rule twice — here, and again inline in the
 * guard — and tested only this one. Mutation m6 walked straight through: flip the
 * guard's copy and a process with BOTH flags set permits the write, with every test
 * still green. Two copies of a safety rule is one copy that is untested by construction,
 * and it is always the copy that runs.
 */
export function resolveMachineWriteMode(env: NodeJS.ProcessEnv = process.env): MachineWriteMode {
  return machineWriteMode(isReadOnlyRuntime(env), allowsMachineWrites(env));
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
  /** Defaults to the ANIMA_ALLOW_MACHINE_WRITES environment variable. Injectable for tests. */
  readonly allowMachineWrites?: boolean;
  /**
   * Where the implicit-default warning goes. Defaults to stderr.
   *
   * Injectable because a warning nobody can observe is a warning nobody can test, and
   * an untested warning is the kind that turns out to have been silent all along.
   */
  readonly warn?: (message: string) => void;
}

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * ⚠️ SAY ONLY WHAT THIS HOOK ACTUALLY KNOWS.
 *
 * This runs in `preHandler` — BEFORE the handler. At this point the request has been
 * ADMITTED to a machine-scoped route. Whether it goes on to write anything is not known
 * here and often it does not: the safe probe reaches `POST /api/filesystem/mkdir` and
 * 404s at `realpath()` having written nothing.
 *
 * The first draft said "MACHINE WRITE PERMITTED ... so it wrote machine-scoped state".
 * @milo ran the safe probe against it: 404, nothing written, and stderr announcing a
 * write. **An instrument that overstates in the alarming direction gets disbelieved, and
 * then it is worth less than no instrument** — the next person to see this line on a
 * harmless 404 learns that the warning cries wolf, and the census dies right there.
 *
 * So: admission, which is true of every line this prints. The census counts CALLERS THAT
 * WOULD BE REFUSED AFTER THE FLIP, and admission is exactly that set.
 */
function implicitDefaultWarning(route: GovernedRoute): string {
  return (
    // `route.id` is already "METHOD /path" — do not prefix the method again.
    `[anima] ADMITTED TO A MACHINE-SCOPED ROUTE BY IMPLICIT DEFAULT: ${route.id}. ` +
    `This process set neither ${MACHINE_WRITE_ENV} nor ${READ_ONLY_ENV}, so the request was ` +
    'let through to a handler that MAY write state outside ANIMA_HOME — not because anyone ' +
    'allowed it, but because nobody refused it. (Whether this particular request went on to ' +
    'write anything is not known at this point, and is not the question: the question is that ' +
    'it was not stopped.) That default is being inverted (issue #524): once it flips, this ' +
    `exact request becomes a 403. If this process legitimately needs to write the machine, set ` +
    `${MACHINE_WRITE_ENV}=1 on it NOW, while the permission is still free. If it does not, ` +
    'this line is the bug.'
  );
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
  const allowMachineWrites = options.allowMachineWrites ?? allowsMachineWrites();
  const mode = machineWriteMode(readOnly, allowMachineWrites);
  const warn = options.warn ?? defaultWarn;

  // NOTE: the hook is registered in ALL THREE modes, including the two that permit.
  //
  // The previous cut returned early when read-only was off, and that was the dead-instrument
  // shape one layer up: a flag that does nothing until the default flips cannot be verified
  // before the flip, so "we checked that live still works" would have been necessarily green.
  // The flag has to MEAN something on day one, or step 2 of the migration is decorative.
  //
  // So in the permitting modes the hook does not permit silently. It stamps the mode on the
  // response and, for the default we are deleting, says so out loud.
  const warnedRoutes = new Set<string>();

  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const governed = governedRouteFor(request.method, request.url);
    if (!governed) return;

    // Set BEFORE the branch, so it rides on every outcome: the 403, the handler's 200, and
    // — the point of the whole exercise — the handler's own 404. That is what lets the safe
    // probe (POST /api/filesystem/mkdir at a nonexistent parent, which 404s at realpath()
    // before it writes anything) read a running machine's mode with ZERO machine action.
    reply.header(MACHINE_WRITE_HEADER, mode);

    if (mode === 'refused') {
      return reply.status(403).send({
        error: READ_ONLY_REFUSAL,
        reason: governed.evidence,
        route: governed.id,
        readOnly: true,
      });
    }

    // Once per route per process: loud enough to be found, bounded so it cannot become noise
    // that people learn to scroll past. Every line here is a caller we must migrate before
    // the default flips — this warning is the census.
    if (mode === 'implicit-default' && !warnedRoutes.has(governed.id)) {
      warnedRoutes.add(governed.id);
      warn(implicitDefaultWarning(governed));
    }
  });
}
