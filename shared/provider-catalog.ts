import { z } from 'zod';

export interface ProviderCatalogEntry {
  command: string;
  defaultModel: string;
  dynamicModels?: boolean;
  installHint: string;
  kind: 'claude-code' | 'codex-cli' | 'kimi-cli' | 'grok-cli';
  label: string;
  marketingModelAliases?: string[];
  models: string[];
  reasoningEfforts: string[];
}

export type ProviderKind = ProviderCatalogEntry['kind'];

export const ProviderAvailability = z.object({
  checkedAt: z.string().optional(),
  defaultModel: z.string().optional(),
  kind: z.enum(['claude-code', 'codex-cli', 'kimi-cli', 'grok-cli']),
  modelCheckError: z.string().optional(),
  /**
   * Per-model reasoning effort menus (Grok Build). Missing or empty array means
   * the model does not support effort. When present, UI/config must not show a
   * provider-global effort control for that model.
   */
  modelReasoningEfforts: z.record(z.string(), z.array(z.string())).optional(),
  models: z.array(z.string()).optional(),
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
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
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
  {
    kind: 'grok-cli',
    label: 'Grok Build',
    command: 'grok',
    installHint: 'Install Grok Build so `grok --version` works, then sign in.',
    marketingModelAliases: ['grok-build'],
    models: [],
    defaultModel: '',
    dynamicModels: true,
    // Effort is model-scoped in Grok (supportsReasoningEffort / reasoningEfforts on
    // each catalog entry). Do not expose a provider-wide menu; UI reads live
    // modelReasoningEfforts or grokReasoningEffortsForModel(model).
    reasoningEfforts: [],
  },
];

export function providerCatalog(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.map((entry) => ({
    ...entry,
    ...(entry.marketingModelAliases ? { marketingModelAliases: [...entry.marketingModelAliases] } : {}),
    models: [...entry.models],
    reasoningEfforts: [...entry.reasoningEfforts],
  }));
}

export function providerCatalogEntry(kind: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.kind === kind);
}

export function defaultModelForProvider(kind: string): string | undefined {
  return providerCatalogEntry(kind)?.defaultModel || undefined;
}

export function isSupportedProviderKind(kind: string): boolean {
  return providerCatalogEntry(kind) !== undefined;
}

export function isSupportedProviderModel(kind: string, model: string): boolean {
  const entry = providerCatalogEntry(kind);
  if (!entry) return false;
  if (!entry.dynamicModels) return entry.models.includes(model);
  const normalized = model.trim();
  return normalized.length > 0 && !entry.marketingModelAliases?.includes(normalized);
}

/**
 * Whether `effort` is valid for this provider (and model, when effort is model-scoped).
 * Grok Build requires `model`: composer and other non-reasoning models reject all efforts.
 */
export function isSupportedReasoningEffort(kind: string, effort: string, model?: string): boolean {
  if (kind === 'grok-cli') {
    return grokReasoningEffortsForModel(model).includes(effort);
  }
  return providerCatalogEntry(kind)?.reasoningEfforts.includes(effort) ?? false;
}

/**
 * Reasoning efforts offered for a Grok model when live ACP metadata is unavailable.
 * Matches installed Grok Build 0.2.93 ACP catalog: grok-4.5 → low/medium/high;
 * composer → none. Fail closed for unknown non-`grok-*` ids.
 */
export function grokReasoningEffortsForModel(model: string | undefined): string[] {
  if (!model?.trim()) return [];
  const id = model.trim().toLowerCase();
  if (id.includes('composer')) return [];
  // Live ACP menu for grok-4.5 does not include xhigh.
  if (id.startsWith('grok-')) return ['low', 'medium', 'high'];
  return [];
}

/** Effort menu for the selected model (live availability when present). */
export function reasoningEffortsForModel(
  kind: string,
  model: string | undefined,
  availability?: { modelReasoningEfforts?: Record<string, string[]> } | null,
): string[] {
  if (kind === 'grok-cli') {
    if (model && availability?.modelReasoningEfforts && model in availability.modelReasoningEfforts) {
      return [...(availability.modelReasoningEfforts[model] ?? [])];
    }
    return grokReasoningEffortsForModel(model);
  }
  return [...(providerCatalogEntry(kind)?.reasoningEfforts ?? [])];
}
