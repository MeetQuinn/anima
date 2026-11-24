import { describe, expect, it } from 'vitest';

import { PROVIDER_CATALOG, providerCatalogEntry } from '@shared/provider-catalog';

import { providerLabelList, providerValueLabel } from './provider-display';

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

describe('providerLabelList', () => {
  it('joins catalog labels as an "or" list', () => {
    const [a, b, c] = PROVIDER_CATALOG;
    expect(providerLabelList([a])).toBe(a.label);
    expect(providerLabelList([a, b])).toBe(`${a.label} or ${b.label}`);
    expect(providerLabelList([a, b, c])).toBe(`${a.label}, ${b.label}, or ${c.label}`);
  });

  it('names every provider in the catalog', () => {
    const list = providerLabelList(PROVIDER_CATALOG);
    expect(PROVIDER_CATALOG.filter((entry) => !list.includes(entry.label)).map((entry) => entry.kind)).toEqual([]);
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

  // The entry is as providerCatalogForAvailability returns it: its labels are its own
  // built-in ones, then the names its CLI reported.
  it("names a model by its provider's labels first, then by any built-in label", () => {
    const kimi = {
      modelLabels: Object.fromEntries([
        ['opus', 'Local Builder'],
        ['claude-fable-5-1[1m]', 'Fable'],
        ['__proto__', 'Proto'],
      ]),
    };
    expect(providerValueLabel('opus', kimi)).toBe('Local Builder');
    expect(providerValueLabel('claude-fable-5-1[1m]', kimi)).toBe('Fable');
    expect(providerValueLabel('__proto__', kimi)).toBe('Proto');
    // Only the map's own keys count.
    expect(providerValueLabel('constructor', kimi)).toBe('Constructor');
    expect(providerValueLabel('toString', kimi)).toBe('toString');
    // An id the provider does not name falls back to any built-in label.
    expect(providerValueLabel('claude-sonnet-4-6', kimi)).toBe('Claude Sonnet 4.6');
    expect(providerValueLabel('deepseek/deepseek-v4-flash', { modelLabels: {} })).toBe('DeepSeek V4.1 Flash');
    // OpenCode's retired Flash id shares its name with the listed one, so its id shows.
    expect(providerValueLabel('deepseek/deepseek-v4-flash', providerCatalogEntry('opencode-cli'))).toBe(
      'DeepSeek V4.1 Flash (deepseek/deepseek-v4-flash)',
    );
    expect(providerValueLabel('opus', providerCatalogEntry('claude-code'))).toBe('Opus');
    expect(providerValueLabel('claude-fable-5-1[1m]')).toBe('claude-fable-5-1[1m]');
  });

  it('adds the id to a name another of the menu\'s models shows', () => {
    const opencode = {
      modelLabels: { 'review-a/chat': 'Review Chat', 'review-b/chat': 'Review Chat', 'review-c/solo': 'Solo' },
      models: ['review-a/chat', 'review-b/chat', 'review-c/solo'],
    };
    expect(opencode.models.map((model) => providerValueLabel(model, opencode))).toEqual([
      'Review Chat (review-a/chat)',
      'Review Chat (review-b/chat)',
      'Solo',
    ]);
    // A saved model the menu no longer lists is told apart from a listed one too.
    const later = { ...opencode, models: ['review-b/chat'] };
    expect(providerValueLabel('review-a/chat', later)).toBe('Review Chat (review-a/chat)');
    expect(providerValueLabel('review-b/chat', later)).toBe('Review Chat');
  });

  // The check is on the text a model ends up showing, not on its name: a model can be
  // named what another model shows once its id is added, or after its id.
  it('never shows two models of a menu alike', () => {
    const opencode = {
      modelLabels: {
        'review-a/chat': 'Review Chat',
        'review-a/extra-chat': 'Review Chat (review-a/chat)',
        'review-b/chat': 'Review Chat',
        'review-d/plain': 'review-a/chat',
      },
      models: ['review-a/chat', 'review-b/chat', 'review-a/extra-chat'],
    };
    expect(opencode.models.map((model) => providerValueLabel(model, opencode))).toEqual([
      'review-a/chat',
      'Review Chat (review-b/chat)',
      'Review Chat (review-a/chat) (review-a/extra-chat)',
    ]);
    const more = { ...opencode, models: [...opencode.models, 'review-d/plain'] };
    const shown = more.models.map((model) => providerValueLabel(model, more));
    expect(shown).toEqual([
      'review-a/chat',
      'Review Chat (review-b/chat)',
      'Review Chat (review-a/chat) (review-a/extra-chat)',
      'review-a/chat (review-d/plain)',
    ]);
    expect(new Set(shown).size).toBe(shown.length);
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
