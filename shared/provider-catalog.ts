import { z } from 'zod';

export interface ProviderCatalogEntry {
  command: string;
  defaultModel: string;
  dynamicModels?: boolean;
  installHint: string;
  kind: 'claude-code' | 'codex-cli' | 'kimi-cli' | 'grok-cli' | 'opencode-cli' | 'pi';
  label: string;
  marketingModelAliases?: string[];
  modelReasoningEfforts?: Record<string, string[]>;
  models: string[];
  reasoningEfforts: string[];
}

export type ProviderKind = ProviderCatalogEntry['kind'];

export const ProviderAvailability = z.object({
  checkedAt: z.string().optional(),
  defaultModel: z.string().optional(),
  kind: z.enum(['claude-code', 'codex-cli', 'kimi-cli', 'grok-cli', 'opencode-cli', 'pi']),
  modelCheckError: z.string().optional(),
  /**
   * Per-model reasoning effort menus. Missing or empty array means
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
const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_4_6_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'];
const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/**
 * Effort tokens a Grok model may support. This is the write-time vocabulary only:
 * whether a *specific* model actually supports an effort is decided at runtime by
 * the live ACP catalog (`session/set_model` is gated on it), never inferred here
 * from the model name. Includes `xhigh` so UI values from live ACP (e.g. grok-4.6)
 * can be saved; unadvertised efforts are still not applied at session/set_model.
 */
const GROK_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
// pi thinking levels (`--thinking`). Whether a model honors a level is decided by
// pi's model catalog at runtime; unset means pi's own default for that model.
const PI_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    kind: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    installHint: 'Install Claude Code so `claude --version` works.',
    models: [
      'opus',
      'sonnet',
      'haiku',
      'fable',
      'claude-opus-4-8',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ],
    defaultModel: 'opus',
    modelReasoningEfforts: {
      opus: CLAUDE_REASONING_EFFORTS,
      sonnet: CLAUDE_REASONING_EFFORTS,
      haiku: [],
      fable: CLAUDE_REASONING_EFFORTS,
      'claude-opus-4-8': CLAUDE_REASONING_EFFORTS,
      'claude-opus-4-6': CLAUDE_4_6_REASONING_EFFORTS,
      'claude-sonnet-4-6': CLAUDE_4_6_REASONING_EFFORTS,
    },
    reasoningEfforts: [],
  },
  {
    kind: 'codex-cli',
    label: 'Codex CLI',
    command: 'codex',
    installHint: 'Install Codex CLI so `codex --version` works.',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    defaultModel: 'gpt-5.6-sol',
    modelReasoningEfforts: {
      'gpt-5.6-sol': CODEX_REASONING_EFFORTS,
      'gpt-5.6-terra': CODEX_REASONING_EFFORTS,
      'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
      'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
    },
    reasoningEfforts: [],
  },
  {
    kind: 'kimi-cli',
    label: 'Kimi CLI',
    command: 'kimi',
    installHint: 'Install Kimi CLI so `kimi --version` works.',
    models: [
      'kimi-code/k3',
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed',
    ],
    defaultModel: 'kimi-code/kimi-for-coding',
    modelReasoningEfforts: {
      'kimi-code/k3': ['low', 'high', 'max'],
      'kimi-code/kimi-for-coding': [],
      'kimi-code/kimi-for-coding-highspeed': [],
    },
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
    // each ACP catalog entry). Do not expose a provider-wide menu; UI reads live
    // modelReasoningEfforts, and the runtime applies effort via session/set_model.
    reasoningEfforts: [],
  },
  {
    kind: 'opencode-cli',
    label: 'OpenCode',
    command: 'opencode',
    installHint: 'Install OpenCode so `opencode --version` works, then add a DeepSeek credential.',
    models: [
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash',
    ],
    defaultModel: 'deepseek/deepseek-v4-pro',
    modelReasoningEfforts: {
      'deepseek/deepseek-v4-pro': ['high', 'max'],
      'deepseek/deepseek-v4-flash': ['high', 'max'],
    },
    reasoningEfforts: [],
  },
  {
    kind: 'pi',
    label: 'pi',
    command: 'pi',
    installHint:
      'Install pi so `pi --version` works (`npm install -g @earendil-works/pi-coding-agent`), then add a provider credential.',
    // pi addresses models as `provider/id` across every provider it bundles. The
    // menu is live: the server asks pi (`get_available_models`) which models the
    // machine-level credentials can reach, so nothing is offered that cannot run.
    models: [],
    defaultModel: '',
    dynamicModels: true,
    // pi's thinking levels are provider-wide; models without reasoning ignore them.
    reasoningEfforts: PI_REASONING_EFFORTS,
  },
];

export function providerCatalog(): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.map((entry) => {
    const copy: ProviderCatalogEntry = {
      ...entry,
      models: [...entry.models],
      reasoningEfforts: [...entry.reasoningEfforts],
    };
    if (entry.marketingModelAliases) {
      copy.marketingModelAliases = [...entry.marketingModelAliases];
    }
    if (entry.modelReasoningEfforts) {
      copy.modelReasoningEfforts = Object.fromEntries(
        Object.entries(entry.modelReasoningEfforts).map(([model, efforts]) => [
          model,
          [...efforts],
        ]),
      );
    }
    return copy;
  });
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

export type ReasoningEffortAvailability = {
  modelReasoningEfforts?: Record<string, string[]>;
} | null | undefined;

/**
 * Whether `effort` is a valid token to store for this provider.
 *
 * Grok: when live ACP availability is present **and** includes this model, the
 * per-model menu is authoritative (empty menu ⇒ no effort may be stored). When
 * live data is absent (offline / probe failed / model not in snapshot), fall
 * back to the provider write vocabulary so saves are not blocked. Per-model
 * apply at runtime still gates `session/set_model` on the live catalog.
 */
export function isSupportedReasoningEffort(
  kind: string,
  effort: string,
  model?: string,
  availability?: ReasoningEffortAvailability,
): boolean {
  if (kind === 'grok-cli') {
    if (
      model
      && availability?.modelReasoningEfforts
      && Object.prototype.hasOwnProperty.call(availability.modelReasoningEfforts, model)
    ) {
      return (availability.modelReasoningEfforts[model] ?? []).includes(effort);
    }
    return GROK_REASONING_EFFORTS.includes(effort);
  }
  return reasoningEffortsForModel(kind, model, availability).includes(effort);
}

/**
 * Effort menu to show for the selected model. Static providers use their catalog's
 * exact model menu. Grok is live-only: the ACP catalog (`modelReasoningEfforts`) is
 * the single authority, so absent that data the menu is empty rather than guessed.
 */
export function reasoningEffortsForModel(
  kind: string,
  model: string | undefined,
  availability?: { modelReasoningEfforts?: Record<string, string[]> } | null,
): string[] {
  if (kind === 'grok-cli') {
    if (model && availability?.modelReasoningEfforts && model in availability.modelReasoningEfforts) {
      return [...(availability.modelReasoningEfforts[model] ?? [])];
    }
    return [];
  }
  const entry = providerCatalogEntry(kind);
  if (!entry) return [];
  if (model && entry.modelReasoningEfforts && model in entry.modelReasoningEfforts) {
    return [...(entry.modelReasoningEfforts[model] ?? [])];
  }
  return [...entry.reasoningEfforts];
}
