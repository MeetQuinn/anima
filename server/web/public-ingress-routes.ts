import { request as httpRequest } from 'node:http';

import type { FastifyInstance } from 'fastify';

import { DEFAULT_LINEAR_LISTENER, LINEAR_WEBHOOK_PATH } from '../../shared/linear.js';
import { answerProbe } from '../settings/public-url-check.js';
import { serverConfigStore } from '../storage/schema/server.store.js';

/**
 * Public ingress. The public address points at this dashboard, so one domain and
 * one forwarding target are enough. Linear events are forwarded byte for byte to
 * the runtime's loopback receiver, which verifies signatures and owns intake.
 */
// Apps registered before the shared ingress posted to the receiver's own path.
export const LEGACY_LINEAR_WEBHOOK_PATH = '/webhook';
const PROBE_PATH = '/webhooks/probe/:nonce';

// Linear allows five seconds for a response; the receiver persists within four.
const FORWARD_TIMEOUT_MS = 4_500;
const BODY_LIMIT_BYTES = 256 * 1024;
const RESPONSE_LIMIT_BYTES = 16 * 1024;

function loopbackFor(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return host;
}

interface ForwardResult { status: number; body: string; contentType?: string }

const RECEIVER_UNAVAILABLE: ForwardResult = {
  status: 503,
  body: JSON.stringify({ error: 'The Linear receiver is not running; retry delivery' }),
  contentType: 'application/json',
};

async function forwardToReceiver(raw: Buffer, contentType: string | undefined, signature: string | undefined): Promise<ForwardResult> {
  const receiver = (await serverConfigStore.read()).linearWebhook ?? DEFAULT_LINEAR_LISTENER;
  return new Promise((resolve) => {
    const headers: Record<string, string | number> = { 'content-length': raw.length };
    if (contentType) headers['content-type'] = contentType;
    if (signature) headers['linear-signature'] = signature;
    const forwarded = httpRequest({
      host: loopbackFor(receiver.host), port: receiver.port, method: 'POST', path: '/webhook', headers, timeout: FORWARD_TIMEOUT_MS,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= RESPONSE_LIMIT_BYTES) chunks.push(chunk);
      });
      response.on('end', () => {
        const type = response.headers['content-type'];
        resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8'), ...(type ? { contentType: type } : {}) });
      });
      response.on('error', () => resolve(RECEIVER_UNAVAILABLE));
    });
    forwarded.on('timeout', () => forwarded.destroy(new Error('Linear receiver timed out')));
    forwarded.on('error', () => resolve(RECEIVER_UNAVAILABLE));
    forwarded.end(raw);
  });
}

export function registerPublicIngressRoutes(fastify: FastifyInstance): void {
  fastify.register(async (scope) => {
    // Signatures cover the exact bytes, so the body is never parsed or re-encoded here.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT_BYTES }, (_request, body, done) => done(null, body));
    for (const path of [LINEAR_WEBHOOK_PATH, LEGACY_LINEAR_WEBHOOK_PATH]) {
      scope.post(path, async (request, reply) => {
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const header = request.headers['linear-signature'];
        const result = await forwardToReceiver(raw, request.headers['content-type'], typeof header === 'string' ? header : undefined);
        reply.code(result.status).header('cache-control', 'no-store');
        if (result.contentType) reply.header('content-type', result.contentType);
        return reply.send(result.body);
      });
    }
  });

  // Answers only the probe a reachability check just issued from this process.
  fastify.get(PROBE_PATH, async (request, reply) => {
    const nonce = (request.params as { nonce?: string }).nonce ?? '';
    reply.header('cache-control', 'no-store');
    if (!answerProbe(nonce, request.headers)) return reply.code(404).send({ error: 'unknown_probe' });
    return { probe: nonce };
  });
}
