import { spawn } from 'node:child_process';
import { once } from 'node:events';

import type { Command } from 'commander';
import { z } from 'zod';

import { AgentEnvStore, maskEnvSecret, type AgentEnvKind } from '../env/agent-env-store.js';
import { resolveAgentIdFrom } from '../cli/shared.js';
import { cleanServiceEnv } from '../services/env.js';
import { registerEnvHandoffCommands } from './env-handoff-cli.js';
import { outcomeLine } from './outcome-line.js';

const SharedFlags = z.object({
  agent: z.string().optional(),
});

const EnvSetSchema = SharedFlags.extend({
  key: z.string().min(1),
  secret: z.boolean().default(false),
  value: z.string().optional(),
});

const EnvListSchema = SharedFlags.extend({
  json: z.boolean().default(false),
});

const EnvRunSchema = SharedFlags.extend({
  command: z.array(z.string()).min(1, 'env run requires a command after --'),
  keys: z.string().optional(),
});

const EnvSourceSchema = SharedFlags.extend({
  keys: z.string().optional(),
  secrets: z.boolean().default(false),
});

type EnvSetOptions = z.infer<typeof EnvSetSchema>;
type EnvListOptions = z.infer<typeof EnvListSchema>;
type EnvRunOptions = z.infer<typeof EnvRunSchema>;
type EnvSourceOptions = z.infer<typeof EnvSourceSchema>;

export function registerEnvCommands(program: Command): void {
  const env = program.command('env').description('Manage per-agent command-scoped environment values.');

  registerEnvHandoffCommands(env);

  env
    .command('set <key> [value]')
    .description('Set a per-agent env value. Secret values are read from stdin.')
    .option('--agent <agent>', 'agent id; defaults to ANIMA_AGENT_ID')
    .option('--secret', 'store encrypted in .env.secret; read value from stdin')
    .action(async (key: string, value: string | undefined, _, command) => {
      const opts = EnvSetSchema.parse({ ...command.optsWithGlobals(), key, value });
      await runEnvSet(opts);
    });

  env
    .command('list')
    .description('List configured env keys. Secret values are masked.')
    .option('--agent <agent>', 'agent id; defaults to ANIMA_AGENT_ID')
    .option('--json', 'emit machine-readable JSON')
    .action(async (_, command) => {
      const opts = EnvListSchema.parse(command.optsWithGlobals());
      await runEnvList(opts);
    });

  env
    .command('run')
    .description('Run a command with selected per-agent env values injected.\nUse: anima env run [--keys A,B] -- <command> [args...]')
    .option('--agent <agent>', 'agent id; defaults to ANIMA_AGENT_ID')
    .option('--keys <keys>', 'comma-separated env keys to inject; defaults to all configured keys')
    .allowUnknownOption(true)
    .argument('<command...>')
    .action(async (commandArgs: string[], _, command) => {
      const opts = EnvRunSchema.parse({ ...command.optsWithGlobals(), command: commandArgs });
      await runEnvRun(opts);
    });

  env
    .command('source')
    .description('Print shell export lines for configured env values. Secrets are excluded unless --secrets is passed.')
    .option('--agent <agent>', 'agent id; defaults to ANIMA_AGENT_ID')
    .option('--keys <keys>', 'comma-separated env keys to print; defaults to all printable keys')
    .option('--secrets', 'include secret values in the export output')
    .action(async (_, command) => {
      const opts = EnvSourceSchema.parse(command.optsWithGlobals());
      await runEnvSource(opts);
    });
}

async function runEnvSet(opts: EnvSetOptions): Promise<void> {
  const agentId = resolveEnvAgentId(opts.agent);
  const store = new AgentEnvStore(agentId);
  const kind: AgentEnvKind = opts.secret ? 'secret' : 'plain';
  if (opts.secret && opts.value !== undefined) {
    throw new Error('Secret values must be passed on stdin, not as a command argument');
  }
  const value = opts.secret ? (await stdinText()).replace(/\r?\n$/, '') : opts.value;
  if (value === undefined || value.length === 0) {
    throw new Error(opts.secret ? 'Secret value is required on stdin' : 'Plain env value is required');
  }
  await store.set(opts.key, value, kind);
  console.log(outcomeLine('set', [['key', opts.key], ['kind', kind]]));
}

async function runEnvList(opts: EnvListOptions): Promise<void> {
  const agentId = resolveEnvAgentId(opts.agent);
  const rows = await new AgentEnvStore(agentId).list();
  if (opts.json) {
    console.log(JSON.stringify(rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      value: row.kind === 'secret' ? maskEnvSecret(row.value) : row.value,
    })), null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('No env values configured.');
    return;
  }
  for (const row of rows) {
    const value = row.kind === 'secret' ? maskEnvSecret(row.value) : row.value;
    console.log(`${row.key}\t${row.kind}\t${value}`);
  }
}

async function runEnvRun(opts: EnvRunOptions): Promise<void> {
  const agentId = resolveEnvAgentId(opts.agent);
  const keys = parseKeys(opts.keys);
  const values = await new AgentEnvStore(agentId).valuesFor(keys);
  const [command, ...args] = opts.command;
  if (!command) throw new Error('env run requires a command after --');
  const child = spawn(command, args, {
    env: { ...cleanEnvRunBase(process.env), ...values },
    stdio: 'inherit',
  });
  const [status, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  if (signal) {
    console.error(`env run command terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = status ?? 1;
}

async function runEnvSource(opts: EnvSourceOptions): Promise<void> {
  const agentId = resolveEnvAgentId(opts.agent);
  const snapshot = await new AgentEnvStore(agentId).load();
  const sourceValues = opts.secrets ? { ...snapshot.plain, ...snapshot.secret } : snapshot.plain;
  const selectedKeys = parseKeys(opts.keys) ?? Object.keys(sourceValues).sort();
  const missing = selectedKeys.filter((key) => sourceValues[key] === undefined);
  if (missing.length > 0) throw new Error(`Missing printable env value(s): ${missing.join(', ')}`);
  for (const key of selectedKeys) {
    console.log(`export ${key}=${shellQuote(sourceValues[key] ?? '')}`);
  }
}

function resolveEnvAgentId(agent: string | undefined): string {
  const agentId = resolveAgentIdFrom(agent);
  if (!agentId) throw new Error('Agent not specified. Pass --agent <id> or set ANIMA_AGENT_ID.');
  return agentId;
}

function parseKeys(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const keys = input.split(',').map((key) => key.trim()).filter(Boolean);
  return keys.length > 0 ? keys : undefined;
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function cleanEnvRunBase(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = cleanServiceEnv(env);
  for (const key of Object.keys(next)) {
    if (
      key === 'DOTENV_KEY'
      || key === 'DOTENV_PRIVATE_KEY'
      || key === 'DOTENV_PUBLIC_KEY'
      || key.startsWith('DOTENV_PRIVATE_KEY_')
      || key.startsWith('DOTENV_PUBLIC_KEY_')
    ) {
      delete next[key];
    }
  }
  return next;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
