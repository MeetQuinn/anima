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

/**
 * Display text for a model id or effort. `provider` is the entry the value belongs
 * to, as `providerCatalogForAvailability` returns it: its labels include the names
 * the CLI reported, for ids the built-in catalog has no label for.
 */
export function providerValueLabel(
  value: string | undefined,
  provider?: Pick<ProviderCatalogEntry, 'modelLabels'>,
): string {
  if (!value) return '';
  const liveLabels = provider?.modelLabels;
  // Own keys only: an id like `constructor` must not find Object's members.
  const liveLabel = liveLabels && Object.hasOwn(liveLabels, value) ? liveLabels[value] : undefined;
  const modelLabel = catalogModelLabel(value) ?? liveLabel;
  if (modelLabel) return modelLabel;
  // Reasoning efforts share this helper.
  if (value === 'xhigh') return 'Extra High';
  if (/^[a-z]+$/.test(value)) return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  return value;
}
