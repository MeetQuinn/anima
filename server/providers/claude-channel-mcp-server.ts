import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { errorMessage, nowIso } from '../ids.js';

interface CliArgs {
  agentId: string;
  completionFile?: string;
  itemId?: string;
  targetFile?: string;
}

interface CompletionTarget {
  completionFile: string;
  itemId: string;
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
      'Each message has an item_id attribute. Use normal Anima CLI tools for any needed team action.',
      'When the current turn is finished, call complete with that item_id.',
      'Include text only when a short completion note is useful, such as a no-op reminder or targetless turn.',
      'Do not print or log secrets in completion notes.',
    ].join('\n'),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'complete',
      description: 'Mark the active Anima notification complete after using normal Anima CLI tools for any needed action.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: {
            type: 'string',
            description: 'The item_id from the channel notification metadata.',
          },
          text: {
            type: 'string',
            description: 'Optional short completion note for Anima activity. Leave empty after an ordinary reply sent with Anima CLI.',
          },
        },
        required: ['item_id'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'complete') {
    return {
      content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }
  const args = request.params.arguments ?? {};
  const itemId = typeof args['item_id'] === 'string' ? args['item_id'].trim() : '';
  const text = typeof args['text'] === 'string' ? args['text'].trimEnd() : '';
  if (!itemId) {
    return {
      content: [{ type: 'text', text: 'complete requires item_id' }],
      isError: true,
    };
  }
  const target = await completionTargetFor(itemId);
  if (!target) {
    return {
      content: [{ type: 'text', text: `No active Anima notification for item_id ${itemId}` }],
      isError: true,
    };
  }
  try {
    await writeCompletionFile(target.completionFile, {
      status: 'completed',
      ...(text ? { text } : {}),
    });
    return {
      content: [{ type: 'text', text: `completed ${itemId}` }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `complete failed: ${errorMessage(error)}` }],
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

async function writeCompletionFile(path: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      ...payload,
      completedAt: nowIso(),
    })}\n`,
    'utf8',
  );
}

function parseArgs(args: string[]): CliArgs {
  const agentId = stringArg(args, '--agent-id');
  const completionFile = stringArg(args, '--completion-file');
  const itemId = stringArg(args, '--item-id');
  const targetFile = stringArg(args, '--target-file');
  if (!agentId) throw new Error('--agent-id is required');
  if (!targetFile && !itemId) throw new Error('--item-id or --target-file is required');
  if (!targetFile && !completionFile) throw new Error('--completion-file is required');
  return {
    agentId,
    ...(completionFile ? { completionFile } : {}),
    ...(itemId ? { itemId } : {}),
    ...(targetFile ? { targetFile } : {}),
  };
}

function stringArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1]?.trim();
  return value || undefined;
}

async function completionTargetFor(itemId: string): Promise<CompletionTarget | undefined> {
  if (!cli.targetFile) {
    if (!cli.completionFile || !cli.itemId) return undefined;
    if (itemId !== cli.itemId) return undefined;
    return {
      completionFile: cli.completionFile,
      itemId: cli.itemId,
    };
  }
  const value: unknown = await readTargetFile(cli.targetFile);
  if (!isTargetRecord(value)) return undefined;
  if (itemId !== value.itemId) return undefined;
  return value;
}

async function readTargetFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function isTargetRecord(value: unknown): value is CompletionTarget {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.active === true &&
    typeof record.completionFile === 'string' &&
    typeof record.itemId === 'string'
  );
}
