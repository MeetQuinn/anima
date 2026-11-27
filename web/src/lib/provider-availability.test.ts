import { describe, expect, it } from 'vitest';

import { providerCatalog, type ProviderAvailability } from '@shared/provider-catalog';
import {
  effortOptionsForSelectedModel,
  preferredEffort,
  providerCatalogForAvailability,
  providerModelAuthorityLabel,
  providerReady,
  providerUnavailableHint,
  providerUnavailableLabel,
} from './provider-availability';
import { providerValueLabel } from './provider-display';

const codex = (status: Partial<ProviderAvailability> = {}): ProviderAvailability[] => [
  { kind: 'codex-cli', present: true, ...status },
];

describe('Codex live model list', () => {
  const builtIn = providerCatalog().find((entry) => entry.kind === 'codex-cli')!;
  const codexEntry = (availability: ProviderAvailability[] | null) =>
    providerCatalogForAvailability(providerCatalog(), availability).find((entry) => entry.kind === 'codex-cli')!;

  it('shows the live list and keeps the built-in default when the live list has it', () => {
    const entry = codexEntry(
      codex({
        checkedAt: '2026-11-24T13:00:00.000Z',
        defaultModel: 'gpt-6.2-sol',
        models: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-7-astra'],
      }),
    );
    expect(entry.models).toEqual(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-7-astra']);
    expect(entry.defaultModel).toBe(builtIn.defaultModel);
  });

  it("uses Codex's default when the built-in one is not in the live list", () => {
    const entry = codexEntry(codex({ defaultModel: 'gpt-7-sol', models: ['gpt-7-astra', 'gpt-7-sol'] }));
    expect(entry.defaultModel).toBe('gpt-7-sol');
  });

  it('falls back to the built-in list and stays ready when the live read fails', () => {
    const availability = codex({ checkedAt: '2026-11-24T13:00:00.000Z', modelCheckError: 'model/list failed' });
    const entry = codexEntry(availability);
    expect(entry.models).toEqual(builtIn.models);
    expect(entry.defaultModel).toBe(builtIn.defaultModel);
    expect(providerReady(entry, availability)).toBe(true);
    expect(providerUnavailableLabel(entry, availability)).toBeUndefined();
    expect(providerModelAuthorityLabel(entry, availability)).toBe('Built-in model list');
  });

  it('offers the live effort menu for the selected model', () => {
    const availability = codex({
      defaultModel: 'gpt-7-astra',
      modelReasoningEfforts: { 'gpt-7-astra': ['low', 'high'] },
      models: ['gpt-7-astra'],
    });
    expect(effortOptionsForSelectedModel(codexEntry(availability), 'gpt-7-astra', availability)).toEqual(['low', 'high']);
    expect(effortOptionsForSelectedModel(codexEntry(availability), 'gpt-6-luna', availability)).toEqual(
      builtIn.modelReasoningEfforts?.['gpt-6-luna'],
    );
  });
});

describe('live model labels', () => {
  it("adds the CLI's names for ids the built-in catalog does not label, and keeps the built-in ones", () => {
    const availability: ProviderAvailability[] = [
      {
        kind: 'claude-code',
        modelLabels: { 'claude-fable-5-1[1m]': 'Fable', opus: 'Opus (live)' },
        models: ['opus', 'claude-fable-5-1[1m]'],
        present: true,
      },
    ];
    const entry = providerCatalogForAvailability(providerCatalog(), availability).find(
      (candidate) => candidate.kind === 'claude-code',
    )!;
    expect(entry.models).toEqual(['opus', 'claude-fable-5-1[1m]']);
    expect(entry.modelLabels?.['claude-fable-5-1[1m]']).toBe('Fable');
    expect(entry.modelLabels?.opus).toBe('Opus');
    expect(providerValueLabel('claude-fable-5-1[1m]', entry)).toBe('Fable');
  });
});

describe('preferredEffort', () => {
  it('keeps the current pick while the menu offers it, else Anima default, else the first level', () => {
    expect(preferredEffort(['low', 'high'], 'low')).toBe('low');
    expect(preferredEffort(['high', 'xhigh'], 'low')).toBe('xhigh');
    expect(preferredEffort(['high'], 'xhigh')).toBe('high');
    expect(preferredEffort(['high'])).toBe('high');
    expect(preferredEffort([], 'xhigh')).toBe('');
  });
});

describe('provider copy helpers', () => {
  it('returns installHint for missing providers and sign-in guidance for dynamic providers without models', () => {
    const provider = {
      ...providerCatalog()[0]!,
      installHint: 'Run `npm install -g @example/cli` and `cli login`.',
    };
    expect(providerUnavailableHint(provider, [{ kind: provider.kind, present: false }])).toBe(
      'Run `npm install -g @example/cli` and `cli login`.',
    );
    const dynamicProvider = providerCatalog().find((candidate) => candidate.dynamicModels)!;
    expect(
      providerUnavailableHint(dynamicProvider, [{ kind: dynamicProvider.kind, present: true }]),
    ).toBe('Sign in or add credentials for this provider to load its available models.');
  });

  it('omits providerModelAuthorityLabel once models are checked successfully', () => {
    const entry = providerCatalog().find((candidate) => candidate.kind === 'codex-cli')!;
    const availability = codex({
      checkedAt: '2026-11-24T13:00:00.000Z',
      defaultModel: 'gpt-6.2-sol',
      models: ['gpt-6.2-sol'],
    });
    expect(providerModelAuthorityLabel(entry, availability)).toBeUndefined();
  });

  it('uses typographic ellipsis and clean fallback labels in providerUnavailableLabel', () => {
    const dynamicProvider = providerCatalog().find((candidate) => candidate.dynamicModels)!;
    expect(providerUnavailableLabel(dynamicProvider, undefined)).toBe('checking…');
    expect(
      providerUnavailableLabel(dynamicProvider, [{ kind: dynamicProvider.kind, present: true }]),
    ).toBe('models unavailable');
  });
});
