import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { errorMessage, nowIso } from '../ids.js';
import { runMessageSend } from '../tools/messages.js';

const cli = parseArgs(process.argv.slice(2));

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
  if (itemId !== cli.itemId) {
    return {
      content: [{ type: 'text', text: `No active Anima notification for item_id ${itemId}` }],
      isError: true,
    };
  }
  if (!cli.channel) {
    return {
      content: [{ type: 'text', text: `Anima item ${itemId} does not have a reply target` }],
      isError: true,
    };
  }
  try {
    await runMessageSend(
      {
        agent: cli.agentId,
        channel: cli.channel,
        item: itemId,
        text,
        ...(cli.threadTs ? { threadTs: cli.threadTs } : {}),
      },
      {
        writeOutput(line) {
          process.stderr.write(`[anima-channel] ${line}\n`);
        },
      },
    );
    await writeReplyFile(cli.replyFile, { status: 'replied', text });
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    process.exit(0);
  });
}

async function writeReplyFile(path: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      ...payload,
      repliedAt: nowIso(),
    })}\n`,
    'utf8',
  );
}

function parseArgs(args: string[]): {
  agentId: string;
  channel?: string;
  itemId: string;
  replyFile: string;
  threadTs?: string;
} {
  const agentId = stringArg(args, '--agent-id');
  const channel = stringArg(args, '--channel');
  const itemId = stringArg(args, '--item-id');
  const replyFile = stringArg(args, '--reply-file');
  const threadTs = stringArg(args, '--thread-ts');
  if (!agentId) throw new Error('--agent-id is required');
  if (!itemId) throw new Error('--item-id is required');
  if (!replyFile) throw new Error('--reply-file is required');
  return {
    agentId,
    ...(channel ? { channel } : {}),
    itemId,
    replyFile,
    ...(threadTs ? { threadTs } : {}),
  };
}

function stringArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1]?.trim();
  return value || undefined;
}
