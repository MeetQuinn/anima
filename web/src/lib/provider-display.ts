import { catalogModelLabel, type ProviderCatalogEntry } from '@shared/provider-catalog';

export function providerKindLabel(kind: string, catalog: ProviderCatalogEntry[]): string {
  return catalog.find((entry) => entry.kind === kind)?.label ?? kind;
}

/**
 * Catalog labels as "A, B, or C". Install copy built from this names exactly
 * the providers the create flow offers, so a new provider cannot be left out.
 */
export function providerLabelList(catalog: ProviderCatalogEntry[]): string {
  return new Intl.ListFormat('en', { type: 'disjunction' }).format(catalog.map((entry) => entry.label));
}

/** The entry a model belongs to, or the part of it labels need. */
type LabelSource = Pick<ProviderCatalogEntry, 'modelLabels'> & { models?: readonly string[] };

/**
 * Display text for a model id or effort. `provider` is the entry the model belongs
 * to, as `providerCatalogForAvailability` returns it: its labels are its built-in
 * ones, then the names its CLI reported. They come first, so another provider's
 * built-in name (Claude's `opus`) does not rename a Kimi alias the CLI calls
 * otherwise; an id neither names falls back to any built-in label. Within the
 * provider's menu every model shows different text: see `menuTexts`.
 */
export function providerValueLabel(value: string | undefined, provider?: LabelSource): string {
  if (!value) return '';
  if (!provider?.models) return valueText(value, provider);
  const texts = menuTexts(provider, provider.models);
  // A saved model the menu no longer lists is told apart from the listed ones too.
  return texts.get(value) ?? distinctTexts([...texts.keys(), value], provider).get(value)!;
}

function valueText(value: string, provider?: LabelSource): string {
  const labels = provider?.modelLabels;
  // Own keys only: an id like `constructor` must not find Object's members.
  const ownLabel = labels && Object.hasOwn(labels, value) ? labels[value] : undefined;
  const modelLabel = ownLabel ?? catalogModelLabel(value);
  if (modelLabel) return modelLabel;
  // Reasoning efforts share this helper.
  if (value === 'xhigh') return 'Extra High';
  if (/^[a-z]+$/.test(value)) return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  return value;
}

const menuTextCache = new WeakMap<object, Map<string, string>>();

/** Each listed model's text in the provider's menu, worked out once per entry. */
function menuTexts(provider: LabelSource, models: readonly string[]): Map<string, string> {
  let texts = menuTextCache.get(provider);
  if (!texts) {
    texts = distinctTexts(models, provider);
    menuTextCache.set(provider, texts);
  }
  return texts;
}

/**
 * Text for each model that no other model shows. A model shows its name. While
 * another model shows the same text, both move a step on: first the id follows the
 * name (`Review Chat (review-a/chat)`), then the id alone. No two models share an
 * id, so each clash moves at least one model on, and the steps run out with every
 * text different.
 */
function distinctTexts(models: Iterable<string>, provider: LabelSource): Map<string, string> {
  const names = new Map<string, string>();
  for (const model of models) names.set(model, valueText(model, provider));
  const steps = new Map<string, number>();
  const textOf = (model: string): string => {
    const step = steps.get(model) ?? 0;
    const name = names.get(model)!;
    return step === 0 ? name : step === 1 ? `${name} (${model})` : model;
  };
  for (let clashed = true; clashed; ) {
    clashed = false;
    const owners = new Map<string, string[]>();
    for (const model of names.keys()) {
      const text = textOf(model);
      const group = owners.get(text);
      if (group) group.push(model);
      else owners.set(text, [model]);
    }
    for (const group of owners.values()) {
      if (group.length < 2) continue;
      for (const model of group) {
        const step = steps.get(model) ?? 0;
        if (step < 2) {
          steps.set(model, step + 1);
          clashed = true;
        }
      }
    }
  }
  return new Map([...names.keys()].map((model) => [model, textOf(model)]));
}
