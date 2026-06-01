import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { resolveAnimaHome } from '../anima-home.js';
import { DEFAULT_JSONL_ROTATE_BYTES, JsonlAppendLog } from '../storage/jsonl-log.js';

// Local-only client-error diagnostics.
//
// The dashboard front-end posts uncaught errors here so they land in the
// operator's OWN local logs — this is NOT telemetry: nothing is sent to us or
// any third party, and there is no outbound path. The data stays in the user's
// own runtime/infrastructure (note: over a LAN dashboard the browser and the
// host can be different machines, so it is not "never leaves this computer" —
// it never leaves the user's infrastructure and never reaches us).
//
// Kept separate from activity.jsonl: activity is the agent work/audit trail;
// UI crashes are operator diagnostics, not agent actions.

// Generous upper bounds — reject absurd/abusive payloads at the schema layer.
// Display/storage caps are applied separately via truncate() below.
const ClientErrorPayload = z.object({
  kind: z.enum(['error', 'unhandledrejection', 'render']),
  message: z.string().max(20_000),
  stack: z.string().max(100_000).optional(),
  componentStack: z.string().max(100_000).optional(),
  // pathname only — the client strips origin/query/hash, but defend in depth here too.
  path: z.string().max(4_096),
  userAgent: z.string().max(4_096),
  createdAt: z.string().max(64),
});

type ClientErrorPayload = z.infer<typeof ClientErrorPayload>;

interface StoredClientError {
  kind: ClientErrorPayload['kind'];
  message: string;
  stack?: string;
  componentStack?: string;
  path: string;
  userAgent: string;
  createdAt: string;
  receivedAt: string;
}

// Storage caps — bound what actually hits disk regardless of the schema ceiling.
const MAX_MESSAGE = 2_000;
const MAX_STACK = 8_000;
const MAX_PATH = 1_024;
const MAX_USER_AGENT = 512;
const MAX_CREATED_AT = 64;

// Reject oversized request bodies before parsing (~32KB is ample for a stack).
const BODY_LIMIT_BYTES = 32 * 1024;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

// Defence in depth: store the pathname ONLY. The client sends location.pathname,
// but a buggy/test/malicious caller could send a full URL — parsing against a
// dummy base reduces any absolute URL to its pathname, dropping origin, userinfo
// (`https://token@host/...`), query, and hash, all of which can carry secrets.
function sanitizePath(path: string): string {
  let pathname: string;
  try {
    pathname = new URL(path, 'http://local').pathname;
  } catch {
    // new URL with an absolute base shouldn't throw for a string, but never
    // trust input: fall back to a query/hash-stripped relative path, else '/'.
    pathname = path.startsWith('/') ? (path.split(/[?#]/, 1)[0] ?? '/') : '/';
  }
  return truncate(pathname, MAX_PATH);
}

let cachedLog: JsonlAppendLog<StoredClientError> | undefined;

// Resolved lazily so the ANIMA_HOME scope in effect at request time is honoured.
function clientErrorLog(): JsonlAppendLog<StoredClientError> {
  const path = join(resolveAnimaHome(), 'logs', 'client-errors.jsonl');
  if (!cachedLog || cachedLog.path !== path) {
    cachedLog = new JsonlAppendLog<StoredClientError>(path, { maxBytes: DEFAULT_JSONL_ROTATE_BYTES });
  }
  return cachedLog;
}

export function registerClientErrorRoutes(fastify: FastifyInstance): void {
  fastify.post(
    '/api/client-errors',
    { bodyLimit: BODY_LIMIT_BYTES },
    async (request, reply) => {
      const parsed = ClientErrorPayload.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid client error payload' });
      }

      const payload = parsed.data;
      const record: StoredClientError = {
        kind: payload.kind,
        message: truncate(payload.message, MAX_MESSAGE),
        ...(payload.stack ? { stack: truncate(payload.stack, MAX_STACK) } : {}),
        ...(payload.componentStack
          ? { componentStack: truncate(payload.componentStack, MAX_STACK) }
          : {}),
        path: sanitizePath(payload.path),
        userAgent: truncate(payload.userAgent, MAX_USER_AGENT),
        createdAt: truncate(payload.createdAt, MAX_CREATED_AT),
        receivedAt: new Date().toISOString(),
      };

      try {
        await clientErrorLog().append(record);
      } catch (error) {
        // Diagnostics must never become a source of 5xx noise of their own.
        request.log?.error?.(
          `Failed to append client error log: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Fire-and-forget contract: never echo the payload back.
      return reply.status(204).send();
    },
  );
}
