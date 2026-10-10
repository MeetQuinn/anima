import type { Command } from 'commander';
import { z } from 'zod';
import { resolveAgentIdFrom } from '../cli/shared.js';
import { readStdin, resolveToolItemId } from './tool-context.js';
import { LinearActivityKind } from '../../shared/linear.js';
import { LinearIdentityService } from '../linear/identity.service.js';
import { LinearSessionService } from '../linear/session.service.js';
import { withToolActivity } from './tool-context.js';

function serviceFor(agent: string | undefined): LinearSessionService {
  const id = resolveAgentIdFrom(agent);
  if (!id) throw new Error('--agent or ANIMA_AGENT_ID is required');
  return new LinearSessionService(new LinearIdentityService(id));
}

export function registerLinearCommands(program: Command): void {
  const linear = program.command('linear').description('Read and report in this agent’s accepted Linear sessions.').option('--agent <id>', 'agent identity');
  linear.command('read').requiredOption('--session <id>', 'Linear session UUID').action(async (_options, command: Command) => {
    const opts = command.optsWithGlobals();
    console.log(JSON.stringify(await serviceFor(opts.agent).read(z.string().uuid().parse(opts.session)), null, 2));
  });
  linear.command('respond').requiredOption('--session <id>', 'Linear session UUID')
    .option('--kind <kind>', 'response, elicitation or error', 'response').action(async (_options, command: Command) => {
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
