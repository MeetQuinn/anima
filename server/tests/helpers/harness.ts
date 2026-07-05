import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withAnimaHome } from '../anima-home.js';
import type { FeishuConfig } from '../../../shared/agent-config.js';

export type TestAgentConfig = Omit<ReturnType<typeof defaultAgentConfig>, 'slack'> & {
  enabled?: boolean;
  homePath?: string;
  profile?: { displayName?: string; role?: string };
  slack?: ReturnType<typeof defaultAgentConfig>['slack'] & { appId?: string; manifestVersion?: number; teamId?: string };
};

export function defaultAgentConfig(id: string) {
  return {
    id,
    provider: {
      env: { CODEX_SECRET: 'runtime-secret-value' },
      kind: 'codex-cli',
      model: 'gpt-5.2-codex',
      reasoningEffort: 'high',
    },
    slack: { appToken: 'xapp-secret-value', botToken: 'xoxb-secret-value' },
  };
}

export async function withTempAnimaHome<T>(body: (stateDir: string) => Promise<T>, options: { prefix?: string } = {}): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), options.prefix ?? 'anima-test-'));
  const previousHome = process.env.ANIMA_HOME;
  process.env.ANIMA_HOME = stateDir;
  try {
    return await withAnimaHome(stateDir, () => body(stateDir));
  } finally {
    if (previousHome === undefined) delete process.env.ANIMA_HOME;
    else process.env.ANIMA_HOME = previousHome;
    await rm(stateDir, { force: true, recursive: true });
  }
}

export async function writeAgentConfigs(configDir: string, agents: TestAgentConfig[] = [defaultAgentConfig('anima')]): Promise<void> {
  await mkdir(configDir, { recursive: true });
  await writeJson(join(configDir, 'config.json'), {});
  for (const agent of agents) {
    const agentDir = join(configDir, 'agents', agent.id);
    const homePath = agent.homePath ?? join(configDir, 'agent-homes', agent.id);
    await mkdir(homePath, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeJson(join(agentDir, 'config.json'), { ...agent, homePath });
  }
}

export async function writeSlackAgentConfig(
  configDir: string,
  slack: { appToken?: string; botToken?: string; teamId?: string } = {},
): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const agent = {
    id: 'scout',
    slack: { appToken: slack.appToken ?? 'xapp-test', botToken: slack.botToken ?? 'xoxb-test', teamId: slack.teamId ?? 'T-demo' },
  };
  const agentDir = join(configDir, 'agents', agent.id);
  await mkdir(agentDir, { recursive: true });
  await writeJson(join(configDir, 'config.json'), {});
  await writeJson(join(agentDir, 'config.json'), agent);
}

export async function writeFeishuAgentConfig(configDir: string, feishu: Partial<FeishuConfig> = {}): Promise<void> {
  const agentDir = join(configDir, 'agents', 'scout');
  const homePath = join(configDir, 'home');
  await mkdir(agentDir, { recursive: true });
  await mkdir(homePath, { recursive: true });
  await writeJson(join(configDir, 'config.json'), {});
  await writeJson(join(agentDir, 'config.json'), {
      feishu: { appId: 'cli_test', appSecret: 'secret', ...feishu },
      homePath,
      id: 'scout',
      provider: { kind: 'codex-cli', model: 'gpt-5.5' },
  });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { description?: string; intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1000;
  const intervalMs = options.intervalMs ?? 10;
  const description = options.description ?? predicate.toString();
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      if (await predicate()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const cause = lastError instanceof Error ? `; last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}${cause}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
