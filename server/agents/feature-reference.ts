import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentConfig } from '../../shared/agent-config.js';
import { readBundledTemplate } from '../bundled-templates.js';
import { isMissingFile } from '../storage/json-file.js';

export const AGENT_FEATURE_REFERENCE_FILE = 'ANIMA_FEATURES.md';

const TEMPLATE_FILE = 'agent-feature-reference.md';

export async function writeAgentFeatureReference(agent: Pick<AgentConfig, 'homePath'>): Promise<void> {
  if (!agent.homePath) throw new Error('Agent homePath is required');
  await mkdir(agent.homePath, { recursive: true });
  const path = join(agent.homePath, AGENT_FEATURE_REFERENCE_FILE);
  const body = await renderAgentFeatureReference();
  try {
    if (await readFile(path, 'utf8') === body) return;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await writeFile(path, body, 'utf8');
}

export function renderAgentFeatureReference(): Promise<string> {
  return readBundledTemplate(TEMPLATE_FILE);
}
