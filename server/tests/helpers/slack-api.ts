import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';

export type SlackApiMockResponse = object | { body: object; headers?: Record<string, string> };

export interface SlackTestBlock {
  action_id?: string;
  elements?: Array<{ action_id?: string; value?: string }>;
  text?: string;
  type: string;
}

export async function startSlackApiMock(
  handler: (method: string, body: string, request: IncomingMessage) => SlackApiMockResponse,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(async (request, response) => {
    const body = await readHttpBody(request);
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const normalizedMethod = pathname.replace(/^\/api\//, '');
      const result = handler(normalizedMethod, body, request);
      const payload = isMockResponseWithHeaders(result) ? result.body : result;
      response.writeHead(200, {
        'content-type': 'application/json',
        ...(isMockResponseWithHeaders(result) ? result.headers : {}),
      });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ok: false }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected Slack API mock to listen on a TCP address.');
  }
  return {
    close: async () => {
      server.close();
      await once(server, 'close');
    },
    url: `http://127.0.0.1:${address.port}/api`,
  };
}

function isMockResponseWithHeaders(value: SlackApiMockResponse): value is { body: object; headers?: Record<string, string> } {
  return 'body' in value && typeof value.body === 'object';
}

export function slackRequestBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(body));
  }
}

export function slackBlocks(body: { blocks?: unknown }): SlackTestBlock[] {
  if (Array.isArray(body.blocks)) {
    return body.blocks as SlackTestBlock[];
  }
  if (typeof body.blocks !== 'string') throw new Error('Expected Slack blocks field');
  return JSON.parse(body.blocks) as SlackTestBlock[];
}

export function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
}

export async function readHttpBody(request: IncomingMessage): Promise<string> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  return body;
}
