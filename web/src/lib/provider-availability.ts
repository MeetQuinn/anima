import type { ProviderCatalogEntry } from '@shared/provider-catalog';
import type { ProviderAvailability } from '@shared/provider-catalog';
import { reasoningEffortsForModel } from '@shared/provider-catalog';

export function providerCatalogForAvailability(
  providers: ProviderCatalogEntry[],
  availability: ProviderAvailability[] | null | undefined,
): ProviderCatalogEntry[] {
  return providers.map((provider) => {
    if (!provider.dynamicModels) return provider;
    const status = providerStatus(provider, availability ?? null);
    return {
      ...provider,
      defaultModel: status?.defaultModel ?? '',
      models: status?.models ?? [],
    };
  });
}

/** Effort menu for the selected model (Grok is model-scoped). */
export function effortOptionsForSelectedModel(
  provider: ProviderCatalogEntry | undefined,
  model: string | undefined,
  availability: ProviderAvailability[] | null | undefined,
): string[] {
  if (!provider) return [];
  const status = providerStatus(provider, availability ?? null);
  return reasoningEffortsForModel(provider.kind, model, status);
}

export function providerStatus(
  provider: ProviderCatalogEntry,
  availability: ProviderAvailability[] | null,
): ProviderAvailability | undefined {
  return availability?.find((item) => item.kind === provider.kind);
}

export function providerModelAuthorityLabel(
  provider: ProviderCatalogEntry | undefined,
  availability: ProviderAvailability[] | null | undefined,
): string | undefined {
  if (!provider?.dynamicModels) return undefined;
  const status = providerStatus(provider, availability ?? null);
  if (!status?.checkedAt || !status.defaultModel || !status.models?.length) {
    return 'Model catalog not checked';
  }
  const checkedAt = new Date(status.checkedAt);
  const rendered = Number.isNaN(checkedAt.getTime()) ? status.checkedAt : checkedAt.toLocaleString();
  return `Model catalog checked ${rendered}`;
}

export function providerReady(
  provider: ProviderCatalogEntry | undefined,
  availability: ProviderAvailability[] | null | undefined,
): boolean {
  if (!provider || !availability) return false;
  const status = providerStatus(provider, availability);
  if (status?.present !== true) return false;
  return !provider.dynamicModels || Boolean(status.defaultModel && status.models?.length);
}

export function firstReadyProvider(
  providers: ProviderCatalogEntry[],
  availability: ProviderAvailability[] | null,
): ProviderCatalogEntry | undefined {
  return providers.find((provider) => providerReady(provider, availability));
}

export function providerUnavailableLabel(
  provider: ProviderCatalogEntry,
  availability: ProviderAvailability[] | null | undefined,
): string | undefined {
  if (!availability) return 'checking...';
  const status = providerStatus(provider, availability);
  if (!status?.present) return 'not installed';
  if (provider.dynamicModels && (!status.defaultModel || !status.models?.length)) {
    return 'models not checked';
  }
  return undefined;
}

export function providerUnavailableHint(
  provider: ProviderCatalogEntry | undefined,
  availability: ProviderAvailability[] | null | undefined,
): string | undefined {
  if (!provider || !availability) return undefined;
  const status = providerStatus(provider, availability);
  if (!status?.present) return provider.installHint;
  if (provider.dynamicModels && (!status.defaultModel || !status.models?.length)) {
    return status.modelCheckError ?? 'Sign in to this provider so Anima can read its current model catalog.';
  }
  return undefined;
}

export function unavailableProviderHints(
  providers: ProviderCatalogEntry[],
  availability: ProviderAvailability[] | null | undefined,
): Array<{ hint: string; kind: ProviderCatalogEntry['kind']; label: string; status: string }> {
  if (!availability) return [];
  return providers.flatMap((provider) => {
    const label = providerUnavailableLabel(provider, availability);
    const hint = providerUnavailableHint(provider, availability);
    return label && hint ? [{ kind: provider.kind, label: provider.label, status: label, hint }] : [];
  });
}
