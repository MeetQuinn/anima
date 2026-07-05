import type { Command } from 'commander';
import { z } from 'zod';

import { resolveAgentIdFrom } from '../cli/shared.js';
import {
  formatPlaces,
  formatWhois,
  placesForAgent,
  whoisForAgent,
  type OrientationDeps,
} from './orientation.js';

const GlobalFlags = z.object({
  agent: z.string().optional(),
});

const PlacesSchema = GlobalFlags.extend({
  all: z.boolean().default(false),
});

const WhoisSchema = GlobalFlags.extend({
  target: z.string().trim().min(1),
});

export type PlacesOptions = z.infer<typeof PlacesSchema>;
export type WhoisOptions = z.infer<typeof WhoisSchema>;

export function registerOrientationCommands(program: Command): void {
  program
    .command('whois')
    .description('Resolve a Slack or Feishu user, bot, channel, or chat id live.')
    .argument('<target>', 'user/bot/channel/chat handle or id, such as @milo, #team, U..., C..., ou_..., or oc_...')
    .action(async (target, command) => {
      await runWhois({ ...command.optsWithGlobals(), target });
    });

  program
    .command('places')
    .description('Show where this agent is present, with newest deliveries last.')
    .option('--all', 'show all places instead of the 50 most recently delivered per section')
    .action(async (_, command) => {
      await runPlaces(PlacesSchema.parse(command.optsWithGlobals()));
    });
}

export async function runWhois(opts: WhoisOptions, deps?: OrientationDeps): Promise<void> {
  const parsed = WhoisSchema.parse(opts);
  const agentId = resolveAgentIdFrom(parsed.agent);
  if (!agentId) throw new Error('whois requires current agent context');
  console.log(formatWhois(await whoisForAgent({ agentId, deps, target: parsed.target })));
}

export async function runPlaces(opts: PlacesOptions, deps?: OrientationDeps): Promise<void> {
  const parsed = PlacesSchema.parse(opts);
  const agentId = resolveAgentIdFrom(parsed.agent);
  if (!agentId) throw new Error('places requires current agent context');
  console.log(formatPlaces(await placesForAgent({ agentId, deps }), { all: parsed.all }));
}
