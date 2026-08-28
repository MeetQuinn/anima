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
