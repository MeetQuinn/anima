import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import { z } from 'zod';
import { resolveAgentIdFrom } from '../cli/shared.js';
import { readStdin, readOptionalStdin, resolveToolItemId } from './tool-context.js';
import { LinearActivityKind } from '../../shared/linear.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearIssueService, LinearIssueCreate, LinearCommentCreate } from '../linear/issue.service.js';
import { LinearSessionService } from '../linear/session.service.js';
import { withToolActivity } from './tool-context.js';

function identityFor(agent: string | undefined): LinearIdentityService {
  const id = resolveAgentIdFrom(agent);
  if (!id) throw new Error('--agent or ANIMA_AGENT_ID is required');
  return new LinearIdentityService(id);
}

function serviceFor(agent: string | undefined): LinearSessionService {
  return new LinearSessionService(identityFor(agent));
}

function pageOptions(command: Command): Command {
  return command.option('--limit <count>', 'page size (1–100)', '50').option('--after <cursor>', 'next page cursor');
}

export function registerLinearCommands(program: Command): void {
  const linear = program.command('linear').description('Use this agent’s Linear identity for issues, comments and work sessions.').option('--agent <id>', 'agent identity');
  // Credentials and arbitrary API bodies deliberately avoid activity payloads:
  // those records are not a place to copy access tokens or arbitrary secrets.
  linear.command('token').description('Get a current access token (JSON); keep it private.')
    .action(async (_options, command: Command) => {
      const { accessToken, expiresAt, organizationId, appUserId } = await identityFor(command.optsWithGlobals().agent).credentials();
      console.log(JSON.stringify({ accessToken, expiresAt, organizationId, appUserId }, null, 2));
    });
  linear.command('api').description('Send GraphQL JSON {query, variables?, operationName?} from stdin; no automatic retry.')
    .action(async (_options, command: Command) => {
      let raw: unknown;
      try { raw = JSON.parse(await readStdin()); } catch { throw new Error('Expected GraphQL JSON with query, optional variables and operationName.'); }
      const input = z.object({ query: z.string().trim().min(1).max(100_000), variables: z.record(z.string(), z.unknown()).default({}), operationName: z.string().min(1).optional() }).strict().parse(raw);
      const result = await identityFor(command.optsWithGlobals().agent).request(input.query, input.variables, z.unknown(), input.operationName);
      console.log(JSON.stringify(result, null, 2));
    });
  pageOptions(linear.command('teams').description('List teams this app can access.')).action(async (_options, command: Command) => {
    const opts = command.optsWithGlobals();
    console.log(JSON.stringify(await new LinearIssueService(identityFor(opts.agent)).teams({ limit: Number(opts.limit), after: opts.after }), null, 2));
  });
  pageOptions(linear.command('search <text>').description('Search issues visible to this app.')).action(async (text: string, _options, command: Command) => {
    const opts = command.optsWithGlobals();
    console.log(JSON.stringify(await new LinearIssueService(identityFor(opts.agent)).search(text, { limit: Number(opts.limit), after: opts.after }), null, 2));
  });
  pageOptions(linear.command('issue <id>').description('Read an issue (UUID or ABC-123) and one page of comments.')).action(async (id: string, _options, command: Command) => {
    const opts = command.optsWithGlobals();
    console.log(JSON.stringify(await new LinearIssueService(identityFor(opts.agent)).read(id, { limit: Number(opts.limit), after: opts.after }), null, 2));
  });
  linear.command('create').description('Create an issue; optional Markdown description on stdin.')
    .requiredOption('--team <uuid>', 'team UUID (see linear teams)').requiredOption('--title <title>', 'issue title')
    .option('--id <uuid>', 'stable issue UUID; generated and printed before sending if omitted')
    .action(async (_options, command: Command) => {
      const opts = command.optsWithGlobals();
      const input = LinearIssueCreate.parse({ id: opts.id ?? randomUUID(), teamId: opts.team, title: opts.title, description: await readOptionalStdin() });
      const identity = identityFor(opts.agent);
      console.error(`Linear issue id: ${input.id}. If the result is unknown, inspect this id before retrying.`);
      const result = await withToolActivity({
        audit: { agentId: identity.agentId }, effectType: 'linear.issue.create',
        basePayload: { tool: 'anima.linear.create', platform: 'linear', channelKind: 'linear_issue', channel: input.id, title: input.title, text: [input.title, input.description].filter(Boolean).join('\n\n'), messageId: input.id },
        onCompletedAuditError: () => console.error('Linear accepted the issue; local audit is degraded. Do not resend.'),
        op: async () => {
          const issue = await new LinearIssueService(identity).create(input);
          return { result: issue, completedPayload: { permalink: issue.url, identifier: issue.identifier } };
        },
      });
      console.log(JSON.stringify(result, null, 2));
    });
  linear.command('comment').description('Comment on any permitted issue; Markdown body on stdin.')
    .requiredOption('--issue <id>', 'issue UUID or identifier').option('--reply-to <uuid>', 'parent comment UUID')
    .option('--id <uuid>', 'stable comment UUID; generated and printed before sending if omitted')
    .action(async (_options, command: Command) => {
      const opts = command.optsWithGlobals();
      const input = LinearCommentCreate.parse({ id: opts.id ?? randomUUID(), issueId: opts.issue, parentId: opts.replyTo, body: await readStdin() });
      const identity = identityFor(opts.agent);
      console.error(`Linear comment id: ${input.id}. If the result is unknown, inspect this id before retrying.`);
      const result = await withToolActivity({
        audit: { agentId: identity.agentId }, effectType: 'linear.comment.create',
        basePayload: { tool: 'anima.linear.comment', platform: 'linear', channelKind: 'linear_issue', channel: input.issueId, threadTs: input.parentId, text: input.body },
        onCompletedAuditError: () => console.error('Linear accepted the comment; local audit is degraded. Do not resend.'),
        op: async () => {
          const comment = await new LinearIssueService(identity).comment(input);
          return { result: comment, completedPayload: { messageId: comment.id, permalink: comment.url, threadTs: comment.parentId ?? comment.id } };
        },
      });
      console.log(JSON.stringify(result, null, 2));
    });
  linear.command('read').requiredOption('--session <id>', 'Linear session UUID').action(async (_options, command: Command) => {
    const opts = command.optsWithGlobals();
    console.log(JSON.stringify(await serviceFor(opts.agent).read(z.string().uuid().parse(opts.session)), null, 2));
  });
  linear.command('respond').requiredOption('--session <id>', 'Linear session UUID')
    .option('--kind <kind>', 'thought (progress), response, elicitation or error', 'response').action(async (_options, command: Command) => {
      const opts = command.optsWithGlobals();
      const sessionId = z.string().uuid().parse(opts.session);
      const kind = LinearActivityKind.parse(opts.kind);
      const body = z.string().trim().min(1).max(100_000).parse(await readStdin());
      const service = serviceFor(opts.agent);
      const result = await withToolActivity({
        audit: { agentId: service.agentId }, effectType: 'linear.activity.create',
        basePayload: { tool: 'anima.linear.respond', platform: 'linear', channelKind: 'linear_session', channel: sessionId, threadTs: sessionId, kind, text: body },
        onCompletedAuditError: () => console.error('Linear accepted the activity; local audit is degraded. Do not resend.'),
        op: async () => {
          const result = await service.respond(sessionId, kind, body, await resolveToolItemId({ agent: service.agentId }));
          return { result, completedPayload: { messageId: result.activityId, bookkeeping: result.bookkeeping } };
        },
      });
      console.log(`Linear accepted activity ${result.activityId}; bookkeeping=${result.bookkeeping}.`);
    });
  linear.command('attach-pr').requiredOption('--session <id>', 'Linear session UUID').requiredOption('--url <url>', 'HTTPS pull request URL')
    .action(async (_options, command: Command) => {
      const opts = command.optsWithGlobals();
      const url = z.string().url().refine((value) => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; }).parse(opts.url);
      const service = serviceFor(opts.agent);
      const sessionId = z.string().uuid().parse(opts.session);
      const result = await withToolActivity({
        audit: { agentId: service.agentId }, effectType: 'linear.link.attach',
        basePayload: { tool: 'anima.linear.attach-pr', platform: 'linear', channel: sessionId, url },
        onCompletedAuditError: () => console.error('Linear accepted the link; local audit is degraded. Do not resend.'),
        op: async () => {
          const result = await service.attach(sessionId, url, await resolveToolItemId({ agent: service.agentId }));
          return { result, completedPayload: { bookkeeping: result.bookkeeping } };
        },
      });
      console.log(`Linear accepted the pull request link; bookkeeping=${result.bookkeeping}.`);
    });
}
