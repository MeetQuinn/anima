import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { errorMessage, nowIso } from '../ids.js';
import { runMessageSend } from '../tools/messages.js';

interface PendingNotification {
  channel?: string;
  itemId: string;
  response: ServerResponse;
  threadTs?: string;
}

interface NotifyRequest {
  channel?: string;
  itemId?: string;
  platform?: string;
  prompt?: string;
  threadTs?: string;
}

const agentId = requiredEnv('ANIMA_AGENT_ID');
const stateFile = requiredEnv('ANIMA_CLAUDE_CHANNEL_STATE_FILE');
const pendingByItemId = new Map<string, PendingNotification>();

const mcp = new Server(
  { name: 'anima', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'Anima delivers team messages through this channel.',
      'Each message has an item_id attribute. Reply by calling the reply tool with that item_id and the message text.',
      'The reply tool routes through Anima, so do not print or log secrets in replies.',
    ].join('\n'),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a reply to the Anima team message that delivered this channel notification.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: {
            type: 'string',
            description: 'The item_id from the channel notification metadata.',
          },
          text: {
            type: 'string',
            description: 'Markdown reply text to send through Anima.',
          },
        },
        required: ['item_id', 'text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'reply') {
    return {
      content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }
  const args = request.params.arguments ?? {};
  const itemId = typeof args['item_id'] === 'string' ? args['item_id'].trim() : '';
  const text = typeof args['text'] === 'string' ? args['text'].trimEnd() : '';
  if (!itemId || !text) {
    return {
      content: [{ type: 'text', text: 'reply requires item_id and text' }],
      isError: true,
    };
  }
  const pending = pendingByItemId.get(itemId);
  if (!pending) {
    return {
      content: [{ type: 'text', text: `No active Anima notification for item_id ${itemId}` }],
      isError: true,
    };
  }
  if (!pending.channel) {
    return {
      content: [{ type: 'text', text: `Anima item ${itemId} does not have a reply target` }],
      isError: true,
    };
  }
  try {
    await runMessageSend(
      {
        agent: agentId,
        channel: pending.channel,
        item: itemId,
        text,
        ...(pending.threadTs ? { threadTs: pending.threadTs } : {}),
      },
      {
        writeOutput(line) {
          process.stderr.write(`[anima-channel] ${line}\n`);
        },
      },
    );
    completePending(pending, { status: 'replied', text });
    return {
      content: [{ type: 'text', text: `sent reply for ${itemId}` }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `reply failed: ${errorMessage(error)}` }],
      isError: true,
    };
  }
});

await mcp.connect(new StdioServerTransport());

const httpServer = createServer((request, response) => {
  void handleHttpRequest(request, response).catch((error: unknown) => {
    sendJson(response, 500, { error: errorMessage(error) });
  });
});

httpServer.listen(0, '127.0.0.1', async () => {
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    process.stderr.write('[anima-channel] failed to determine HTTP listener address\n');
    process.exit(1);
  }
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(
    stateFile,
    `${JSON.stringify({
      host: '127.0.0.1',
      pid: process.pid,
      port: address.port,
      startedAt: nowIso(),
    })}\n`,
    'utf8',
  );
  process.stderr.write(`[anima-channel] listening on 127.0.0.1:${address.port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    httpServer.close();
    process.exit(0);
  });
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true, pending: pendingByItemId.size });
    return;
  }
  if (request.method !== 'POST' || url.pathname !== '/notify') {
    sendJson(response, 404, { error: 'not found' });
    return;
  }

  const body = await readJsonBody(request) as NotifyRequest;
  const itemId = body.itemId?.trim();
  const prompt = body.prompt?.trim();
  if (!itemId || !prompt) {
    sendJson(response, 400, { error: 'itemId and prompt are required' });
    return;
  }
  if (pendingByItemId.has(itemId)) {
    sendJson(response, 409, { error: `item ${itemId} is already pending` });
    return;
  }
  const pending: PendingNotification = {
    itemId,
    response,
    ...(body.channel ? { channel: body.channel } : {}),
    ...(body.threadTs ? { threadTs: body.threadTs } : {}),
  };
  pendingByItemId.set(itemId, pending);
  response.on('close', () => {
    if (!response.writableEnded) pendingByItemId.delete(itemId);
  });
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: prompt,
      meta: {
        item_id: itemId,
        ...(body.channel ? { channel: body.channel } : {}),
        ...(body.platform ? { platform: body.platform } : {}),
        ...(body.threadTs ? { thread_ts: body.threadTs } : {}),
      },
    },
  });
}

function completePending(pending: PendingNotification, payload: Record<string, unknown>): void {
  pendingByItemId.delete(pending.itemId);
  sendJson(pending.response, 200, payload);
}

function sendJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('error', reject);
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
