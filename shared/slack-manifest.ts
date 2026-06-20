// Slack app manifest migration contract shared by server and web.

import { z } from 'zod';

export const CURRENT_SLACK_MANIFEST_VERSION = 2;

export interface AgentSlackManifestUpdateInfo {
  agentVersion: number;
  appManifestUrl?: string;
  currentVersion: number;
  manifestUpdateYaml: string;
  needsUpdate: boolean;
  reinstallUrl?: string;
}

export const AgentSlackManifestUpgradeRequest = z.object({
  botToken: z.string().trim().min(1).refine((value) => value.startsWith('xoxb-'), {
    message: 'botToken must start with xoxb-',
  }),
}).strict();

export type AgentSlackManifestUpgradeRequest = z.infer<typeof AgentSlackManifestUpgradeRequest>;
