import type { Command } from 'commander';
import { z } from 'zod';

import {
  DEFAULT_HANDOFF_EXPIRY_MS,
  MAX_HANDOFF_EXPIRY_MS,
  MIN_HANDOFF_EXPIRY_MS,
  createHandoffKeyPair,
  createHandoffRequest,
  assertHandoffSenderForRequest,
  encodeHandoffRequest,
  encryptHandoffSecret,
  formatHandoffBoxForSlack,
  formatHandoffRequestForSlack,
  handoffSecretFingerprint,
  parseHandoffBox,
  parseHandoffRequest,
} from '../../shared/secret-handoff.js';
import {
  AgentEnvExistsError,
  AgentEnvStore,
  assertEnvKeyAllowed,
} from '../env/agent-env-store.js';
import { SecretHandoffPendingStore } from '../env/secret-handoff-store.js';
import { resolveAgentIdFrom } from '../cli/shared.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { outcomeLine } from './outcome-line.js';

export const HANDOFF_PAGE_ORIGIN = 'https://handoff.meetanima.online';
const HANDOFF_PAGE_ORIGIN_ENV = 'ANIMA_HUMAN_HANDOFF_PAGE_ORIGIN';

const SharedFlags = z.object({
  agent: z.string().optional(),
});

const RequestSchema = SharedFlags.extend({
  key: z.string().min(1),
  purpose: z.string().min(1).max(500),
  from: z.string().optional(),
  allowAnySender: z.boolean().default(false),
  fromHuman: z.boolean().default(false),
  expires: z.string().optional(),
});

const SendSchema = SharedFlags.extend({
  request: z.string().min(1),
  fromKey: z.string().min(1),
});

const AcceptSchema = SharedFlags.extend({
  box: z.string().min(1),
  replace: z.boolean().default(false),
});

const CancelSchema = SharedFlags.extend({
  requestId: z.string().min(1),
});

type RequestOptions = z.infer<typeof RequestSchema>;
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
    .command('request <key>')
    .description('Create a one-time recipient-bound secret request.')
    .option('--agent <agent>', 'recipient agent id; defaults to ANIMA_AGENT_ID')
    .requiredOption('--purpose <purpose>', 'why this secret is needed')
    .option(
      '--from <agent>',
      'expected sending agent id (default sender policy)',
    )
    .option(
      '--allow-any-sender',
      'allow any trusted agent in the workspace to send',
    )
    .option(
      '--from-human',
      'let a human encrypt the value in the Anima Secure Handoff page',
    )
    .option('--expires <duration>', 'expiry from now (5m to 7d; default 24h)')
    .action(async (key: string, _, command) => {
      const opts = RequestSchema.parse({ ...command.optsWithGlobals(), key });
      await runHandoffRequest(opts);
    });

  handoff
    .command('send <request>')
    .description(
      "Encrypt one of this agent's secret env values for a handoff request.",
    )
    .option('--agent <agent>', 'sending agent id; defaults to ANIMA_AGENT_ID')
    .requiredOption('--from-key <key>', 'source secret env key')
    .action(async (request: string, _, command) => {
      const opts = SendSchema.parse({ ...command.optsWithGlobals(), request });
      await runHandoffSend(opts);
    });

  handoff
    .command('accept <box>')
    .description(
      "Explicitly decrypt and store a handoff box in this agent's encrypted env.",
    )
    .option('--agent <agent>', 'recipient agent id; defaults to ANIMA_AGENT_ID')
    .option(
      '--replace',
      'replace an existing secret env value with the same key',
    )
    .action(async (box: string, _, command) => {
      const opts = AcceptSchema.parse({ ...command.optsWithGlobals(), box });
      await runHandoffAccept(opts);
    });

  handoff
    .command('cancel <request-id>')
    .description('Destroy a pending handoff private key.')
    .option('--agent <agent>', 'recipient agent id; defaults to ANIMA_AGENT_ID')
    .action(async (requestId: string, _, command) => {
      const opts = CancelSchema.parse({
        ...command.optsWithGlobals(),
        requestId,
      });
      await runHandoffCancel(opts);
    });
}

async function runHandoffRequest(opts: RequestOptions): Promise<void> {
  const agentId = resolveHandoffAgentId(opts.agent);
  assertEnvKeyAllowed(opts.key);
  const senderChoices =
    Number(Boolean(opts.from)) +
    Number(opts.allowAnySender) +
    Number(opts.fromHuman);
  if (senderChoices !== 1) {
    throw new Error(
      'Choose exactly one sender policy: --from <agent>, --allow-any-sender, or --from-human',
    );
  }
  const pageOrigin = opts.fromHuman ? humanHandoffPageOrigin() : undefined;
  const expiryMs = opts.expires
    ? parseExpiry(opts.expires)
    : DEFAULT_HANDOFF_EXPIRY_MS;
  const keys = createHandoffKeyPair();
  const sender = await requestSender(opts, agentId);
  const request = createHandoffRequest({
    recipientAgentId: agentId,
    targetKey: opts.key,
    purpose: opts.purpose,
    sender,
    expiresAt: new Date(Date.now() + expiryMs),
    publicKey: keys.publicKey,
  });
  await new SecretHandoffPendingStore(agentId).create(request, keys.privateKey);
  const code = encodeHandoffRequest(request);
  const senderLabel =
    request.senderKind === 'agent'
      ? request.expectedSenderAgentId
      : request.senderKind === 'human'
        ? `human in ${request.workspaceName}`
        : request.senderKind;
  console.log(
    outcomeLine('handoff request created', [
      ['id', request.requestId],
      ['key', request.targetKey],
      ['sender', senderLabel],
    ]),
  );
  console.log(formatRequestForSlack(request, code, pageOrigin));
}

function humanHandoffPageOrigin(): string {
  const configured = process.env[HANDOFF_PAGE_ORIGIN_ENV]?.replace(/\/+$/, '');
  if (!configured) {
    throw new Error(
      'Human secret handoff is not enabled until the secure page deployment is verified',
    );
  }
  if (configured !== HANDOFF_PAGE_ORIGIN) {
    throw new Error('Human secret handoff page origin is not trusted by this build');
  }
  return configured;
}

async function requestSender(
  opts: RequestOptions,
  agentId: string,
): Promise<
  | { kind: 'agent'; agentId: string }
  | { kind: 'any-workspace-agent' }
  | { kind: 'human'; workspaceId: string; workspaceName: string }
> {
  if (opts.from) return { kind: 'agent', agentId: opts.from };
  if (opts.allowAnySender) return { kind: 'any-workspace-agent' };
  const agent = await defaultAgentRegistryService
    .serviceFor(agentId)
    .getConfig();
  if (
    !agent.slack.connected ||
    !agent.slack.teamId ||
    !agent.slack.workspaceName
  ) {
    throw new Error(
      `Agent ${agentId} needs a connected Slack workspace before requesting a human handoff`,
    );
  }
  return {
    kind: 'human',
    workspaceId: agent.slack.teamId,
    workspaceName: agent.slack.workspaceName,
  };
}

function formatRequestForSlack(
  request: ReturnType<typeof createHandoffRequest>,
  code: string,
  pageOrigin?: string,
): string {
  const expires = `<t:${Math.floor(Date.parse(request.expiresAt) / 1000)}:f>`;
  if (request.senderKind === 'human') {
    if (!pageOrigin) throw new Error('Human secret handoff page is not enabled');
    const pageUrl = `${pageOrigin}/#${code}`;
    return [
      `${request.recipientAgentId} requests \`${request.targetKey}\``,
      `Purpose: ${escapeSlackText(request.purpose)}`,
      `Destination: ${request.recipientAgentId}'s local encrypted env`,
      'Slack and the Anima handoff page never receive the plaintext',
      `Workspace: ${escapeSlackText(request.workspaceName)}`,
      `Expires: ${expires}`,
      '',
      `<${pageUrl}|Securely provide secret>`,
    ].join('\n');
  }
  return [
    `${request.recipientAgentId} requests \`${request.targetKey}\``,
    `Purpose: ${escapeSlackText(request.purpose)}`,
    `Sender: ${request.senderKind === 'agent' ? `\`${request.expectedSenderAgentId}\`` : 'any trusted workspace agent (explicit open request)'}`,
    `Expires: ${expires}`,
    '',
    formatHandoffRequestForSlack(code),
  ].join('\n');
}

async function runHandoffSend(opts: SendOptions): Promise<void> {
  const agentId = resolveHandoffAgentId(opts.agent);
  assertEnvKeyAllowed(opts.fromKey);
  const request = parseHandoffRequest(opts.request);
  if (request.senderKind === 'human')
    throw new Error('Human handoff requests must be completed in the browser');
  assertHandoffSenderForRequest(request, { kind: 'agent', agentId });
  const snapshot = await new AgentEnvStore(agentId).load();
  const value = snapshot.secret[opts.fromKey];
  if (value === undefined)
    throw new Error(
      `Secret env key ${opts.fromKey} was not found for agent ${agentId}`,
    );
  const box = await encryptHandoffSecret(request, {
    sender: { kind: 'agent', agentId },
    value,
  });
  console.log(
    outcomeLine('handoff box prepared', [
      ['id', request.requestId],
      ['key', request.targetKey],
      ['recipient', request.recipientAgentId],
    ]),
  );
  console.log(formatHandoffBoxForSlack(box));
}

async function runHandoffAccept(opts: AcceptOptions): Promise<void> {
  const agentId = resolveHandoffAgentId(opts.agent);
  const box = parseHandoffBox(opts.box);
  const pending = new SecretHandoffPendingStore(agentId);
  const env = new AgentEnvStore(agentId);
  try {
    const result = await pending.consume(
      box.requestId,
      opts.box,
      async (payload) => {
        await env.set(payload.targetKey, payload.value, 'secret', {
          replace: opts.replace,
        });
        return {
          key: payload.targetKey,
          sender:
            payload.senderKind === 'agent' ? payload.senderAgentId : 'human',
          fingerprint: await handoffSecretFingerprint(payload.value),
        };
      },
    );
    console.log(
      outcomeLine('handoff accepted', [
        ['key', result.key],
        ['kind', 'secret'],
        ['from', result.sender],
        ['fingerprint', result.fingerprint],
      ]),
    );
  } catch (error) {
    if (error instanceof AgentEnvExistsError) {
      await pending.resetRejectedWrite(box.requestId);
      if (error.kind === 'secret') {
        throw new Error(`${error.message}. Pass --replace to replace it.`);
      }
    }
    throw error;
  }
}

async function runHandoffCancel(opts: CancelOptions): Promise<void> {
  const agentId = resolveHandoffAgentId(opts.agent);
  const cancelled = await new SecretHandoffPendingStore(agentId).cancel(
    opts.requestId,
  );
  if (!cancelled) throw new Error('Pending handoff request was not found');
  console.log(outcomeLine('handoff cancelled', [['id', opts.requestId]]));
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

function escapeSlackText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
