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
 * otherwise; an id neither names falls back to any built-in label. When another of
 * the provider's models shows the same text, the id follows it, so the two can be
 * told apart in a menu.
 */
export function providerValueLabel(value: string | undefined, provider?: LabelSource): string {
  if (!value) return '';
  const text = valueText(value, provider);
  if (!provider?.models) return text;
  const { listed, shown } = menuTexts(provider, provider.models);
  const others = (shown.get(text) ?? 0) - (listed.has(value) ? 1 : 0);
  return others > 0 ? `${text} (${value})` : text;
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

/** How many of a provider's models show each text, worked out once per entry. */
const menuTextCache = new WeakMap<object, { listed: Set<string>; shown: Map<string, number> }>();

function menuTexts(provider: LabelSource, models: readonly string[]) {
  let texts = menuTextCache.get(provider);
  if (!texts) {
    const listed = new Set(models);
    const shown = new Map<string, number>();
    for (const model of listed) {
      const text = valueText(model, provider);
      shown.set(text, (shown.get(text) ?? 0) + 1);
    }
    texts = { listed, shown };
    menuTextCache.set(provider, texts);
  }
  return texts;
}
