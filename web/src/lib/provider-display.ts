import type { ProviderCatalogEntry } from '@shared/provider-catalog';

export function providerKindLabel(kind: string, catalog: ProviderCatalogEntry[]): string {
  return catalog.find((entry) => entry.kind === kind)?.label ?? kind;
}

export function providerValueLabel(value: string | undefined): string {
  if (!value) return '';
  if (value === 'xhigh') return 'Extra High';
  if (value === 'claude-opus-4-8') return 'Claude Opus 4.8';
  if (value === 'claude-opus-4-6') return 'Claude Opus 4.6';
  if (value === 'claude-sonnet-4-6') return 'Claude Sonnet 4.6';
  if (value === 'deepseek/deepseek-v4-pro') return 'DeepSeek V4 Pro';
  if (value === 'deepseek/deepseek-v4-flash') return 'DeepSeek V4 Flash';
  if (/^[a-z]+$/.test(value)) return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  return value;
}
