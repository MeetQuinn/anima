import type { ServerResponse } from 'node:http';

import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { errorMessage } from '../ids.js';
import { KbError } from '../kb/kb.helper.js';

export function registerErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error, _request, reply) => {
    const ownCode = (error as { statusCode?: unknown }).statusCode;
    const statusCode =
      error instanceof ZodError
        ? 400
        : error instanceof HttpError || error instanceof KbError
        ? error.statusCode
        : typeof ownCode === 'number' && ownCode >= 400 && ownCode < 600
          ? ownCode
          : 500;
    const message =
      error instanceof ZodError ? (error.issues[0]?.message ?? 'invalid request') : errorMessage(error);
    void reply.status(statusCode).send({ error: message });
  });
}

export function routePath(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}

export function queryParam(rawUrl: string | undefined, key: string): string | undefined {
  try {
    const value = new URL(rawUrl ?? '/', 'http://127.0.0.1').searchParams.get(key)?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

// Agent homes, knowledge bases, and chat uploads hold files the operator did
// not write. Served inline from the dashboard origin, an HTML or SVG file
// opened in its own tab would run with the dashboard's own access. A CSP
// sandbox without allow-same-origin gives the document an opaque origin: it
// still renders, runs its scripts, and follows links, but it cannot read the
// dashboard API, and the cross-site write guard refuses its writes. A sandbox
// often breaks the browser's built-in PDF viewer (the dashboard's PDF preview
// skips its iframe sandbox for the same reason), so PDFs keep only nosniff.
const UNTRUSTED_FILE_SANDBOX =
  'sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads';

export function untrustedFileHeaders(contentType: string, policy?: string): Record<string, string> {
  const isPdf = contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/pdf';
  const csp = [policy, isPdf ? undefined : UNTRUSTED_FILE_SANDBOX].filter(Boolean).join('; ');
  return {
    ...(csp ? { 'content-security-policy': csp } : {}),
    'x-content-type-options': 'nosniff',
  };
}

export function sendJsonRaw(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

export function stringValue(value: unknown, key: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${key} must be a string`);
  return value.trim();
}

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
