import { describe, expect, it } from 'vitest';

import { PROVIDER_CATALOG } from '@shared/provider-catalog';

import { providerValueLabel } from './provider-display';

describe('catalog model labels', () => {
  it('names every model id the catalog offers', () => {
    const unlabeled = PROVIDER_CATALOG.flatMap((entry) =>
      entry.models
        .filter((model) => !entry.modelLabels?.[model]?.trim())
        .map((model) => `${entry.kind}:${model}`),
    );
    expect(unlabeled).toEqual([]);
  });

  it('only labels ids a static provider actually lists', () => {
    const orphaned = PROVIDER_CATALOG.filter((entry) => !entry.dynamicModels).flatMap((entry) =>
      Object.keys(entry.modelLabels ?? {})
        .filter((model) => !entry.models.includes(model))
        .map((model) => `${entry.kind}:${model}`),
    );
    expect(orphaned).toEqual([]);
  });

  it('gives an id shared by two providers the same label', () => {
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const entry of PROVIDER_CATALOG) {
      for (const [model, label] of Object.entries(entry.modelLabels ?? {})) {
        const prior = seen.get(model);
        if (prior !== undefined && prior !== label) conflicts.push(`${model}: ${prior} / ${label}`);
        seen.set(model, label);
      }
    }
    expect(conflicts).toEqual([]);
  });
});

describe('providerValueLabel', () => {
  it('renders model ids with their catalog label', () => {
    expect(providerValueLabel('opus')).toBe('Opus');
    expect(providerValueLabel('claude-opus-4-8')).toBe('Claude Opus 4.8');
    expect(providerValueLabel('claude-sonnet-4-6')).toBe('Claude Sonnet 4.6');
    expect(providerValueLabel('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(providerValueLabel('gpt-5.5')).toBe('GPT-5.5');
    expect(providerValueLabel('kimi-code/k3')).toBe('K3');
    expect(providerValueLabel('kimi-code/kimi-for-coding')).toBe('K2.7 Coding');
    expect(providerValueLabel('deepseek/deepseek-v4-pro')).toBe('DeepSeek V4 Pro');
    expect(providerValueLabel('deepseek/deepseek-v4-flash')).toBe('DeepSeek V4.1 Flash');
  });

  it('labels known ids from dynamic providers', () => {
    expect(providerValueLabel('deepseek/deepseek-flash')).toBe('DeepSeek V4.1 Flash');
    expect(providerValueLabel('deepseek/deepseek-v4-flash-vision-exp')).toBe('DeepSeek V4.1 Flash');
  });

  it('shows an unknown model id as-is', () => {
    expect(providerValueLabel('grok-4.6')).toBe('grok-4.6');
    expect(providerValueLabel('anthropic/claude-x')).toBe('anthropic/claude-x');
  });

  it('renders reasoning efforts', () => {
    expect(providerValueLabel('xhigh')).toBe('Extra High');
    expect(providerValueLabel('high')).toBe('High');
    expect(providerValueLabel('max')).toBe('Max');
    expect(providerValueLabel(undefined)).toBe('');
  });
});
