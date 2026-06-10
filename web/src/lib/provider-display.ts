import type { ProviderCatalogEntry } from '@shared/provider-catalog';

export function providerKindLabel(kind: string, catalog: ProviderCatalogEntry[]): string {
  return catalog.find((entry) => entry.kind === kind)?.label ?? kind;
}

export function providerValueLabel(value: string | undefined): string {
  if (!value) return '';
  if (value === 'claude-fable-5') return 'Claude Fable 5';
  if (value === 'claude-opus-4-8') return 'Claude Opus 4.8';
  if (value === 'claude-sonnet-4-6') return 'Claude Sonnet 4.6';
  if (value === 'claude-haiku-4-5') return 'Claude Haiku 4.5';
  if (value === 'xhigh') return 'Extra High';
  if (/^[a-z]+$/.test(value)) return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  return value;
}
