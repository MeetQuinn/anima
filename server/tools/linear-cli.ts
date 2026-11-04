import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import { resolveAgentIdFrom } from '../cli/shared.js';
import { resolveAnimaReferencePaths } from '../runtime/anima-reference.js';
import { readStdin, resolveToolItemId } from './tool-context.js';
import { LinearActivityKind } from '../../shared/linear.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearCommentService, LinearCommentCreate, LinearCommentReply, type LinearCreatedComment } from '../linear/comment.service.js';
import { LinearSessionService } from '../linear/session.service.js';
import { formatLinearReplyTarget, parseLinearReplyTarget } from '../linear/reply-target.js';
import { withToolActivity } from './tool-context.js';
import { runLinearApi } from './linear-api.js';

function identityFor(agent: string | undefined): LinearIdentityService {
  const id = resolveAgentIdFrom(agent);
  if (!id) throw new Error('--agent or ANIMA_AGENT_ID is required');
  return new LinearIdentityService(id);
}

function serviceFor(agent: string | undefined): LinearSessionService {
  return new LinearSessionService(identityFor(agent));
}

const ReplyBody = z.string().trim().min(1).max(100_000);

async function sendSessionActivity(agent: string | undefined, tool: string, sessionId: string, kind: LinearActivityKind, body: string): Promise<void> {
  const service = serviceFor(agent);
  const result = await withToolActivity({
    audit: { agentId: service.agentId }, effectType: 'linear.activity.create',
    basePayload: { tool, platform: 'linear', channelKind: 'linear_session', channel: sessionId, threadTs: sessionId, kind, text: body },
    onCompletedAuditError: () => console.error('Linear accepted the activity; local audit is degraded. Do not resend.'),
    op: async () => {
      const result = await service.respond(sessionId, kind, body, await resolveToolItemId({ agent: service.agentId }));
      return { result, completedPayload: {
        channel: result.issueId ?? sessionId, channelKind: result.issueId ? 'linear_issue' : 'linear_session',
        issueKey: result.issueKey, issueTitle: result.issueTitle, permalink: result.issueUrl,
        messageId: result.activityId, bookkeeping: result.bookkeeping,
      } };
    },
  });
  console.log(`Linear accepted activity ${result.activityId}; bookkeeping=${result.bookkeeping}.`);
}

async function sendComment(agent: string | undefined, tool: string, basePayload: Record<string, unknown>, id: string,
  create: (service: LinearCommentService) => Promise<LinearCreatedComment>): Promise<LinearCreatedComment> {
  const identity = identityFor(agent);
  console.error(`Linear comment id: ${id}. If the result is unknown, inspect this id before retrying.`);
  return withToolActivity({
    audit: { agentId: identity.agentId }, effectType: 'linear.comment.create',
    basePayload: { tool, platform: 'linear', channelKind: 'linear_issue', ...basePayload },
    onCompletedAuditError: () => console.error('Linear accepted the comment; local audit is degraded. Do not resend.'),
    op: async () => {
      const comment = await create(new LinearCommentService(identity));
      return { result: comment, completedPayload: {
        channel: comment.issueId, issueKey: comment.issue.identifier, issueTitle: comment.issue.title,
        messageId: comment.id, permalink: comment.issue.url, threadTs: comment.parentId ?? comment.id,
      } };
    },
  });
}

export function registerLinearCommands(program: Command): void {
  const linear = program.command('linear').description('Use this agent’s Linear identity for issues, comments and work sessions.').option('--agent <id>', 'agent identity')
    .addHelpText('after', () => {
      const { docsPath } = resolveAnimaReferencePaths();
      const guide = docsPath ? join(docsPath, 'agent', 'linear.md') : 'https://github.com/MeetQuinn/anima/blob/main/docs/agent/linear.md';
      return `\nUse api for issue and session reads, issue changes and external links.\nExamples and pagination: ${guide}`;
    });
  // Credential output is for programmatic consumption, not activity records.
  // Arbitrary API calls record only fixed metadata, never their bodies.
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
      const result = await runLinearApi(identityFor(command.optsWithGlobals().agent), input);
      console.log(JSON.stringify(result, null, 2));
    });
  linear.command('reply').description('Reply where a Linear envelope points; Markdown body on stdin.')
    .requiredOption('--to <reply_to>', 'reply_to from the envelope: session:<uuid>, comment:<uuid> or issue:<id>')
    .option('--kind <kind>', 'response, thought (progress), elicitation (question) or error', 'response')
    .option('--id <uuid>', 'comment and issue targets: stable comment UUID; generated and printed before sending if omitted')
    .action(async (_options, command: Command) => {
      const opts = command.optsWithGlobals();
      const target = parseLinearReplyTarget(String(opts.to));
      const kind = LinearActivityKind.parse(opts.kind);
      if (target.kind === 'session' && opts.id) throw new Error('--id applies to comment and issue targets; Anima deduplicates session replies itself.');
      // A comment is permanent and notifies the thread; progress belongs only in a work session.
      if (target.kind !== 'session' && kind === 'thought') throw new Error('Progress updates go only to work sessions. In a comment thread or issue, reply with your result or question.');
      const body = ReplyBody.parse(await readStdin());
      if (target.kind === 'session') { await sendSessionActivity(opts.agent, 'anima.linear.reply', target.id, kind, body); return; }
      const id = z.string().uuid().parse(opts.id ?? randomUUID());
      const comment = target.kind === 'comment'
        ? await sendComment(opts.agent, 'anima.linear.reply', { threadTs: target.id, text: body }, id,
          (service) => service.reply(LinearCommentReply.parse({ id, commentId: target.id, body })))
        : await sendComment(opts.agent, 'anima.linear.reply', { channel: target.id, text: body }, id,
          (service) => service.comment(LinearCommentCreate.parse({ id, issueId: target.id, body })));
      console.log(`Linear accepted comment ${comment.id}: ${comment.url}`);
    });
  // Earlier names for the same writes. Hidden so agents learn one reply command.
  linear.command('comment', { hidden: true }).description('Comment on any permitted issue; Markdown body on stdin. Prefer reply.')
    .requiredOption('--issue <id>', 'issue UUID or identifier').option('--reply-to <uuid>', 'parent comment UUID')
    .option('--id <uuid>', 'stable comment UUID; generated and printed before sending if omitted')
    .action(async (_options, command: Command) => {
      const opts = command.optsWithGlobals();
      const input = LinearCommentCreate.parse({ id: opts.id ?? randomUUID(), issueId: opts.issue, parentId: opts.replyTo, body: await readStdin() });
      const result = await sendComment(opts.agent, 'anima.linear.comment', { channel: input.issueId, threadTs: input.parentId, text: input.body }, input.id,
        (service) => service.comment(input));
      console.log(JSON.stringify(result, null, 2));
    });
  linear.command('start').description('Start work proactively; initial progress on stdin. No assignment is required.')
    .option('--issue <id>', 'issue UUID or identifier').option('--comment <uuid>', 'comment UUID (a reply resolves to its root)')
    .option('--request-id <uuid>', 'reuse this id to inspect a previous start, never to blindly resend it')
    .action(async (_options, command: Command) => {
      const opts = command.optsWithGlobals();
      if (Boolean(opts.issue) === Boolean(opts.comment)) throw new Error('Specify exactly one of --issue or --comment.');
      const target = opts.comment ? 'comment' : 'issue';
      const targetId = target === 'comment' ? z.string().uuid().parse(opts.comment) : z.string().trim().min(1).parse(opts.issue);
      const requestId = z.string().uuid().parse(opts.requestId ?? randomUUID());
      const body = z.string().trim().min(1).max(100_000).parse(await readStdin());
      const service = serviceFor(opts.agent);
      const runItemId = await resolveToolItemId({ agent: service.agentId });
      console.error(`Linear start request id: ${requestId}. If the result is unknown, inspect Linear before creating another session.`);
      const result = await withToolActivity({
        audit: { agentId: service.agentId }, effectType: 'linear.session.start',
        basePayload: { tool: 'anima.linear.start', platform: 'linear', channelKind: 'linear_session', text: body, requestId },
        onCompletedAuditError: () => console.error('Linear accepted the session progress; local audit is degraded. Do not resend.'),
        op: async () => {
          const session = await service.start(target, targetId, requestId, runItemId);
          console.error(`Linear session id: ${session.id}`);
          const progress = await service.respond(session.id, 'thought', body, runItemId);
          return { result: { requestId, session, replyTo: formatLinearReplyTarget({ kind: 'session', id: session.id }), progress }, completedPayload: {
            channel: session.issue?.id ?? session.id, channelKind: session.issue ? 'linear_issue' : 'linear_session', threadTs: session.id,
            issueKey: session.issue?.identifier, issueTitle: session.issue?.title, permalink: session.issue?.url,
            messageId: progress.activityId, bookkeeping: progress.bookkeeping,
          } };
        },
      });
      console.log(JSON.stringify(result, null, 2));
    });
  linear.command('respond', { hidden: true }).description('Reply to a work session; Markdown body on stdin. Prefer reply.').requiredOption('--session <id>', 'Linear session UUID')
    .option('--kind <kind>', 'thought (progress), response, elicitation or error', 'response').action(async (_options, command: Command) => {
      const opts = command.optsWithGlobals();
      const sessionId = z.string().uuid().parse(opts.session);
      const kind = LinearActivityKind.parse(opts.kind);
      await sendSessionActivity(opts.agent, 'anima.linear.respond', sessionId, kind, ReplyBody.parse(await readStdin()));
    });
}
