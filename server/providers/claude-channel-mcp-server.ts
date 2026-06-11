import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { errorMessage, nowIso } from '../ids.js';
import { runMessageSend } from '../tools/messages.js';

interface CliArgs {
  agentId: string;
  channel?: string;
  itemId?: string;
  replyFile?: string;
  targetFile?: string;
  threadTs?: string;
}

interface ReplyTarget {
  channel?: string;
  itemId: string;
  replyFile: string;
  threadTs?: string;
}

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
  const target = await replyTargetFor(itemId);
  if (!target) {
    return {
      content: [{ type: 'text', text: `No active Anima notification for item_id ${itemId}` }],
      isError: true,
    };
  }
  if (!target.channel) {
    return {
      content: [{ type: 'text', text: `Anima item ${itemId} does not have a reply target` }],
      isError: true,
    };
  }
  try {
    await runMessageSend(
      {
        agent: cli.agentId,
        channel: target.channel,
        item: itemId,
        text,
        ...(target.threadTs ? { threadTs: target.threadTs } : {}),
      },
      {
        writeOutput(line) {
          process.stderr.write(`[anima-channel] ${line}\n`);
        },
      },
    );
    await writeReplyFile(target.replyFile, { status: 'replied', text });
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

function parseArgs(args: string[]): CliArgs {
  const agentId = stringArg(args, '--agent-id');
  const channel = stringArg(args, '--channel');
  const itemId = stringArg(args, '--item-id');
  const replyFile = stringArg(args, '--reply-file');
  const targetFile = stringArg(args, '--target-file');
  const threadTs = stringArg(args, '--thread-ts');
  if (!agentId) throw new Error('--agent-id is required');
  if (!targetFile && !itemId) throw new Error('--item-id or --target-file is required');
  if (!targetFile && !replyFile) throw new Error('--reply-file is required');
  return {
    agentId,
    ...(channel ? { channel } : {}),
    ...(itemId ? { itemId } : {}),
    ...(replyFile ? { replyFile } : {}),
    ...(targetFile ? { targetFile } : {}),
    ...(threadTs ? { threadTs } : {}),
  };
}

function stringArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1]?.trim();
  return value || undefined;
}

async function replyTargetFor(itemId: string): Promise<ReplyTarget | undefined> {
  if (!cli.targetFile) {
    if (!cli.itemId || !cli.replyFile) return undefined;
    if (itemId !== cli.itemId) return undefined;
    return {
      itemId: cli.itemId,
      replyFile: cli.replyFile,
      ...(cli.channel ? { channel: cli.channel } : {}),
      ...(cli.threadTs ? { threadTs: cli.threadTs } : {}),
    };
  }
  const value: unknown = JSON.parse(await readFile(cli.targetFile, 'utf8'));
  if (!isTargetRecord(value)) return undefined;
  if (itemId !== value.itemId) return undefined;
  return value;
}

function isTargetRecord(value: unknown): value is ReplyTarget {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.itemId === 'string'
    && typeof record.replyFile === 'string'
    && (record.channel === undefined || typeof record.channel === 'string')
    && (record.threadTs === undefined || typeof record.threadTs === 'string');
}
