import type {
  ProviderUsageError,
  ProviderUsageRow,
} from '../../shared/provider-usage.js';

export function usageError(type: ProviderUsageError['type'], message: string): ProviderUsageError {
  return { message, type };
}

export function unavailable(
  error: ProviderUsageError,
  account?: string,
): Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'> {
  return {
    ...(account ? { account } : {}),
    error,
    extras: [],
    status: 'unavailable',
    windows: [],
  };
}

export function available(
  windows: ProviderUsageRow['windows'],
  extras: ProviderUsageRow['extras'] = [],
  account?: string,
): Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'> {
  return {
    ...(account ? { account } : {}),
    extras,
    status: 'available',
    windows,
  };
}
