import type { Command } from 'commander';
import { z } from 'zod';

import {
  DEFAULT_HANDOFF_EXPIRY_MS,
  MAX_HANDOFF_EXPIRY_MS,
  MIN_HANDOFF_EXPIRY_MS,
  createHandoffKeyPair,
  encodeSealedHandoffPublicKey,
  encryptSealedHandoffSecret,
  formatSealedHandoffBoxForSlack,
  handoffSecretFingerprint,
  parseSealedHandoffBox,
  parseSealedHandoffPublicKey,
} from '../../shared/secret-handoff.js';
import {
  AgentEnvExistsError,
  AgentEnvStore,
  assertEnvKeyAllowed,
} from '../env/agent-env-store.js';
import { SealedSecretHandoffPendingStore } from '../env/sealed-secret-handoff-store.js';
import { resolveAgentIdFrom } from '../cli/shared.js';
import { outcomeLine } from './outcome-line.js';

export const HANDOFF_PAGE_ORIGIN = 'https://handoff.meetanima.online';

const SharedFlags = z.object({
  agent: z.string().optional(),
});

const ReceiveSchema = SharedFlags.extend({
  expires: z.string().optional(),
});

const SendSchema = SharedFlags.extend({
  publicKey: z.string().min(1),
  fromKey: z.string().min(1),
});

const AcceptSchema = SharedFlags.extend({
  box: z.string().min(1),
  key: z.string().optional(),
  replace: z.boolean().default(false),
});

const CancelSchema = SharedFlags.extend({
  id: z.string().min(1),
});

type ReceiveOptions = z.infer<typeof ReceiveSchema>;
type SendOptions = z.infer<typeof SendSchema>;
type AcceptOptions = z.infer<typeof AcceptSchema>;
type CancelOptions = z.infer<typeof CancelSchema>;

export function registerEnvHandoffCommands(env: Command): void {
  const handoff = env
    .command('handoff')
    .description(
      'Transfer encrypted per-agent secret env values without exposing plaintext to Slack.',
    );

  handoff
    .command('receive')
    .description('Create a one-time public key for receiving an encrypted secret.')
    .option('--agent <agent>', 'recipient agent id; defaults to ANIMA_AGENT_ID')
    .option('--expires <duration>', 'expiry from now (5m to 7d; default 24h)')
    .action(async (_, command) => {
      const opts = ReceiveSchema.parse(command.optsWithGlobals());
      await runHandoffReceive(opts);
    });

  handoff
    .command('send <public-key>')
    .description("Encrypt one of this agent's secret env values for a public key.")
    .option('--agent <agent>', 'sending agent id; defaults to ANIMA_AGENT_ID')
    .requiredOption('--from-key <key>', 'source secret env key')
    .action(async (publicKey: string, _, command) => {
      const opts = SendSchema.parse({ ...command.optsWithGlobals(), publicKey });
      await runHandoffSend(opts);
    });

  handoff
    .command('accept <box>')
    .description(
      "Explicitly decrypt and store a handoff box in this agent's encrypted env.",
    )
    .option('--agent <agent>', 'recipient agent id; defaults to ANIMA_AGENT_ID')
    .option('--key <key>', 'destination secret env key')
    .option(
      '--replace',
      'replace an existing secret env value with the same key',
    )
    .action(async (box: string, _, command) => {
      const opts = AcceptSchema.parse({ ...command.optsWithGlobals(), box });
      await runHandoffAccept(opts);
    });

  handoff
    .command('cancel <key-id>')
    .description('Destroy a pending handoff private key.')
    .option('--agent <agent>', 'recipient agent id; defaults to ANIMA_AGENT_ID')
    .action(async (id: string, _, command) => {
      const opts = CancelSchema.parse({
        ...command.optsWithGlobals(),
        id,
      });
      await runHandoffCancel(opts);
    });
}

async function runHandoffReceive(opts: ReceiveOptions): Promise<void> {
  const agentId = resolveHandoffAgentId(opts.agent);
  const expiryMs = opts.expires
    ? parseExpiry(opts.expires)
    : DEFAULT_HANDOFF_EXPIRY_MS;
  const keys = createHandoffKeyPair();
  const expiresAt = new Date(Date.now() + expiryMs);
  const id = await new SealedSecretHandoffPendingStore(agentId).create(
    keys.publicKey,
    keys.privateKey,
    expiresAt,
  );
  const code = encodeSealedHandoffPublicKey(keys.publicKey);
  console.log(
    outcomeLine('secret handoff ready', [
      ['id', id],
      ['expires', expiresAt.toISOString()],
    ]),
  );
  console.log(`\`\`\`\n${code}\n\`\`\``);
  console.log(`<${HANDOFF_PAGE_ORIGIN}/#${code}|Encrypt a secret>`);
}

async function runHandoffSend(opts: SendOptions): Promise<void> {
  const agentId = resolveHandoffAgentId(opts.agent);
  assertEnvKeyAllowed(opts.fromKey);
  parseSealedHandoffPublicKey(opts.publicKey);

  const snapshot = await new AgentEnvStore(agentId).load();
  const value = snapshot.secret[opts.fromKey];
  if (value === undefined)
    throw new Error(
      `Secret env key ${opts.fromKey} was not found for agent ${agentId}`,
    );
  const box = await encryptSealedHandoffSecret(opts.publicKey, value);
  console.log(outcomeLine('handoff box prepared', [['kind', 'secret']]));
  console.log(formatSealedHandoffBoxForSlack(box));
}

async function runHandoffAccept(opts: AcceptOptions): Promise<void> {
  const agentId = resolveHandoffAgentId(opts.agent);
  if (!opts.key)
    throw new Error('Pass --key <key> to choose where to store this secret');
  const key = opts.key;
  assertEnvKeyAllowed(key);
  parseSealedHandoffBox(opts.box);
  const pending = new SealedSecretHandoffPendingStore(agentId);
  const env = new AgentEnvStore(agentId);
  try {
    const result = await pending.consume(opts.box, async (payload) => {
      await env.set(key, payload.value, 'secret', {
        replace: opts.replace,
      });
      return { fingerprint: await handoffSecretFingerprint(payload.value) };
    });
    console.log(
      outcomeLine('handoff accepted', [
        ['key', key],
        ['kind', 'secret'],
        ['fingerprint', result.fingerprint],
      ]),
    );
  } catch (error) {
    if (error instanceof AgentEnvExistsError) {
      await pending.resetRejectedWrite(opts.box);
      if (error.kind === 'secret') {
        throw new Error(`${error.message}. Pass --replace to replace it.`);
      }
    }
    throw error;
  }
}

async function runHandoffCancel(opts: CancelOptions): Promise<void> {
  const agentId = resolveHandoffAgentId(opts.agent);
  const cancelled = await new SealedSecretHandoffPendingStore(agentId).cancel(opts.id);
  if (!cancelled) throw new Error('Pending handoff key was not found');
  console.log(outcomeLine('handoff cancelled', [['id', opts.id]]));
}

function resolveHandoffAgentId(agent: string | undefined): string {
  const agentId = resolveAgentIdFrom(agent);
  if (!agentId)
    throw new Error(
      'Agent not specified. Pass --agent <id> or set ANIMA_AGENT_ID.',
    );
  return agentId;
}

function parseExpiry(value: string): number {
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (!match)
    throw new Error(
      'Expiry must use a whole-number duration such as 30m, 24h, or 7d',
    );
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const duration = amount * multiplier;
  if (
    !Number.isSafeInteger(duration) ||
    duration < MIN_HANDOFF_EXPIRY_MS ||
    duration > MAX_HANDOFF_EXPIRY_MS
  ) {
    throw new Error('Expiry must be between 5m and 7d');
  }
  return duration;
}
