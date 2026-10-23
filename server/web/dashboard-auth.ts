import type { IncomingHttpHeaders } from 'node:http';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  clearDashboardAuthCookie,
  defaultDashboardAuthService,
  type DashboardAuthService,
} from '../settings/dashboard-auth.service.js';
import { routePath } from './http.js';

const LoginBody = z.object({
  password: z.string().min(1),
}).strict();

const PUBLIC_API_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/session',
  '/api/health',
  '/api/server-info',
]);

const PUBLIC_STATIC_EXTENSIONS = new Set([
  '.css',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.png',
  '.svg',
  '.webmanifest',
  '.woff',
  '.woff2',
]);

interface LoginAttempts { count: number; inFlight: number; resetAt: number }
const failedLogins = new Map<string, LoginAttempts>();
const FAILED_LOGIN_WINDOW_MS = 5 * 60 * 1000;
const FAILED_LOGIN_LIMIT = 10;

export function registerDashboardAuthRoutes(
  fastify: FastifyInstance,
  authService: DashboardAuthService = defaultDashboardAuthService,
): void {
  fastify.get('/api/auth/session', async (request) => authService.status(request.headers));

  fastify.post('/api/auth/login', async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'password is required' });

    const key = failedLoginKey(request);
    const attempt = reserveLoginAttempt(key);
    if (!attempt) return reply.status(429).send({ error: 'Too many login attempts. Try again later.' });

    try {
      const result = await authService.login(parsed.data.password, { secureCookie: requestIsSecure(request) });
      reply.header('set-cookie', result.cookie);
      if (!result.ok) {
        recordFailedLogin(attempt);
        return reply.status(401).send({ error: 'Invalid password' });
      }
      // A success clears failures, but cannot release other requests' reservations.
      attempt.count = 0;
      return { authenticated: result.status.authenticated, enabled: result.status.enabled };
    } finally {
      attempt.inFlight -= 1;
      if (!attempt.inFlight && !attempt.count) failedLogins.delete(key);
    }
  });

  fastify.post('/api/auth/logout', async (_request, reply) => {
    reply.header('set-cookie', clearDashboardAuthCookie());
    return { ok: true };
  });
}

/**
 * Marker decorator, set at registration. Read by `registerReadOnlyGuard`, which must
 * run AFTER this guard so an unauthenticated caller still gets `401` rather than a
 * detailed read-only refusal. Same-type hooks run in registration order, so the
 * ordering is the whole contract — and a comment is not a contract.
 */
export const DASHBOARD_AUTH_GUARD_MARKER = 'dashboardAuthGuardRegistered';

export function registerDashboardAuthGuard(
  fastify: FastifyInstance,
  authService: DashboardAuthService = defaultDashboardAuthService,
): void {
  fastify.decorate(DASHBOARD_AUTH_GUARD_MARKER, true);

  fastify.addHook('preHandler', async (request, reply) => {
    // Decide on the route the router matched, not on the raw request path. The router
    // percent-decodes the path, so `/%61pi/agents` reaches the `/api/agents` handler
    // while its raw path does not start with `/api/`. Unmatched requests fall back to
    // the raw path, so an unknown `/api/...` path still answers 401 before 404.
    const path = request.routeOptions.url ?? routePath(request.url);
    if (!path.startsWith('/api/') && !path.startsWith('/kb/raw/')) return;
    if (isPublicApiPath(path)) return;
    if (await authService.isRequestAuthenticated(request.headers)) return;
    return reply.status(401).send({ error: 'authentication_required' });
  });
}

export async function dashboardStaticRedirectLocation(
  rawUrl: string | undefined,
  headers: IncomingHttpHeaders,
  authService: DashboardAuthService = defaultDashboardAuthService,
): Promise<string | undefined> {
  const path = routePath(rawUrl);
  if (isPublicStaticPath(path)) return undefined;
  if (await authService.isRequestAuthenticated(headers)) return undefined;
  return loginRedirectLocation(rawUrl);
}

export function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PATHS.has(path);
}

export function isPublicStaticPath(path: string): boolean {
  if (path === '/login') return true;
  return isPublicStaticAssetPath(path);
}

export function isPublicStaticAssetPath(path: string): boolean {
  if (path.startsWith('/assets/')) return true;
  return PUBLIC_STATIC_EXTENSIONS.has(fileExtension(path));
}

function loginRedirectLocation(rawUrl: string | undefined): string {
  const next = pathWithSearch(rawUrl);
  return `/login?next=${encodeURIComponent(next || '/')}`;
}

function pathWithSearch(rawUrl: string | undefined): string {
  try {
    const url = new URL(rawUrl ?? '/', 'http://127.0.0.1');
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}

function fileExtension(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const lastDot = path.lastIndexOf('.');
  return lastDot > lastSlash ? path.slice(lastDot).toLowerCase() : '';
}

function requestIsSecure(request: FastifyRequest): boolean {
  const forwarded = request.headers['x-forwarded-proto'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (forwardedValue?.split(',').some((part) => part.trim().toLowerCase() === 'https')) return true;
  return (request as { protocol?: string }).protocol === 'https';
}

/**
 * Failed logins are counted per client. A direct client is its socket address. A loopback
 * socket is a local proxy (cloudflared, Tailscale Serve, a reverse proxy on this host); the
 * client is then the last X-Forwarded-For entry, which that proxy wrote. Earlier entries come
 * from the client itself, so keying on them gave every guess a fresh budget.
 */
function failedLoginKey(request: FastifyRequest): string {
  const peer = request.raw.socket.remoteAddress ?? 'unknown';
  if (!isLoopbackAddress(peer)) return peer;
  const forwarded = request.headers['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  return forwardedValue?.split(',').at(-1)?.trim() || peer;
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function reserveLoginAttempt(key: string): LoginAttempts | undefined {
  const now = Date.now();
  let entry = failedLogins.get(key);
  if (!entry) {
    entry = { count: 0, inFlight: 0, resetAt: now + FAILED_LOGIN_WINDOW_MS };
    failedLogins.set(key, entry);
  } else if (entry.resetAt <= now) {
    // Window expiry forgets failures, never verifications that are still running.
    entry.count = 0;
    entry.resetAt = now + FAILED_LOGIN_WINDOW_MS;
  }
  if (entry.count + entry.inFlight >= FAILED_LOGIN_LIMIT) return undefined;
  entry.inFlight += 1;
  return entry;
}

function recordFailedLogin(entry: LoginAttempts): void {
  const now = Date.now();
  if (entry.resetAt <= now) {
    entry.count = 0;
    entry.resetAt = now + FAILED_LOGIN_WINDOW_MS;
  }
  entry.count += 1;
}
