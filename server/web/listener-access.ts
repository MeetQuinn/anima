import type { IncomingHttpHeaders } from 'node:http';

import type { FastifyInstance } from 'fastify';

export interface WebListenerAccess {
  allowedPeers: string[];
  allowedHosts: string[];
  port: number;
}

export function registerWebListenerAccess(fastify: FastifyInstance, access: WebListenerAccess): void {
  const hosts = new Set(access.allowedHosts.map((host) => `${host}:${access.port}`));
  const peers = new Set(access.allowedPeers);
  // Before body parsing, authentication and every route, including health and
  // static assets. Proxy headers cannot turn an untrusted socket into a peer.
  fastify.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    if (
      !peers.has(request.raw.socket.remoteAddress ?? '') ||
      !host || !hosts.has(host) ||
      (origin !== undefined && origin !== `http://${host}`) ||
      (site !== undefined && site !== 'none' && site !== 'same-origin')
    ) {
      return reply.code(403).header('cache-control', 'no-store').send({ error: 'network_access_denied' });
    }
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses state-changing requests that a browser marks as sent from another site.
 * Without dashboard auth, any page open in the operator's browser could otherwise
 * send body-less POSTs (restart services, disable an agent) to the dashboard.
 * Clients that are not browsers send neither header and are unaffected.
 */
export function registerCrossSiteWriteGuard(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (isSameOriginRequest(request.headers)) return;
    return reply.code(403).header('cache-control', 'no-store').send({ error: 'cross_site_request_denied' });
  });
}

function isSameOriginRequest(headers: IncomingHttpHeaders): boolean {
  // Browsers send Sec-Fetch-Site whatever Host a reverse proxy forwards, so it is
  // the primary signal. Origin is the fallback for browsers that do not send it;
  // only its host is compared, because a TLS-terminating proxy forwards plain HTTP.
  const site = headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin' || site === 'none';
  const origin = headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}
