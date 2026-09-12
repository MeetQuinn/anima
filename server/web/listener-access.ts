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
