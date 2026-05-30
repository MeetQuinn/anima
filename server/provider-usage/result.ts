import type {
  ProviderUsageError,
  ProviderUsageRow,
} from '../../shared/provider-usage.js';

export function usageError(type: ProviderUsageError['type'], message: string): ProviderUsageError {
  return { message, type };
}

export function unavailable(error: ProviderUsageError): Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'> {
  return {
    error,
    extras: [],
    status: 'unavailable',
    windows: [],
  };
}

export function available(
  windows: ProviderUsageRow['windows'],
  extras: ProviderUsageRow['extras'] = [],
): Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'> {
  return {
    extras,
    status: 'available',
    windows,
  };
}
