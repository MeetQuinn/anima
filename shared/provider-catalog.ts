import { z } from 'zod';

export interface ProviderCatalogEntry {
  command: string;
  defaultModel: string;
  installHint: string;
  kind: 'claude-code' | 'codex-cli' | 'kimi-cli';
  label: string;
  models: string[];
  reasoningEfforts: string[];
}

export type ProviderKind = ProviderCatalogEntry['kind'];

export const ProviderAvailability = z.object({
  kind: z.enum(['claude-code', 'codex-cli', 'kimi-cli']),
  present: z.boolean(),
});
export type ProviderAvailability = z.infer<typeof ProviderAvailability>;

export const DEFAULT_PROVIDER_KIND: ProviderCatalogEntry['kind'] = 'claude-code';
export const DEFAULT_REASONING_EFFORT = 'xhigh';
const STANDARD_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    kind: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    installHint: 'Install Claude Code so `claude --version` works.',
    models: ['opus', 'sonnet', 'haiku', 'fable'],
    defaultModel: 'opus',
    reasoningEfforts: STANDARD_REASONING_EFFORTS,
  },
  {
    kind: 'codex-cli',
    label: 'Codex CLI',
    command: 'codex',
    installHint: 'Install Codex CLI so `codex --version` works.',
    models: [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2',
      'gpt-5.2-codex',
    ],
    defaultModel: 'gpt-5.5',
    reasoningEfforts: STANDARD_REASONING_EFFORTS,
  },
  {
    kind: 'kimi-cli',
    label: 'Kimi CLI',
    command: 'kimi',
    installHint: 'Install Kimi CLI so `kimi --version` works.',
    models: ['kimi-code/kimi-for-coding'],
    defaultModel: 'kimi-code/kimi-for-coding',
    reasoningEfforts: [],
  },
];

export function providerCatalog(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.map((entry) => ({
    ...entry,
    models: [...entry.models],
    reasoningEfforts: [...entry.reasoningEfforts],
  }));
}

export function providerCatalogEntry(kind: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.kind === kind);
}

export function defaultModelForProvider(kind: string): string | undefined {
  return providerCatalogEntry(kind)?.defaultModel;
}

export function isSupportedProviderKind(kind: string): boolean {
  return providerCatalogEntry(kind) !== undefined;
}

export function isSupportedProviderModel(kind: string, model: string): boolean {
  return providerCatalogEntry(kind)?.models.includes(model) ?? false;
}

export function isSupportedReasoningEffort(kind: string, effort: string): boolean {
  return providerCatalogEntry(kind)?.reasoningEfforts.includes(effort) ?? false;
}
