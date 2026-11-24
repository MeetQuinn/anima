import { describe, expect, it } from 'vitest';

import { providerCatalog, type ProviderAvailability } from '@shared/provider-catalog';
import {
  effortOptionsForSelectedModel,
  preferredEffort,
  providerCatalogForAvailability,
  providerModelAuthorityLabel,
  providerReady,
  providerUnavailableLabel,
} from './provider-availability';

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

describe('preferredEffort', () => {
  it('keeps the current pick while the menu offers it, else Anima default, else the first level', () => {
    expect(preferredEffort(['low', 'high'], 'low')).toBe('low');
    expect(preferredEffort(['high', 'xhigh'], 'low')).toBe('xhigh');
    expect(preferredEffort(['high'], 'xhigh')).toBe('high');
    expect(preferredEffort(['high'])).toBe('high');
    expect(preferredEffort([], 'xhigh')).toBe('');
  });
});
