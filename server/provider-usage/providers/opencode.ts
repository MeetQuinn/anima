import { join } from 'node:path';

import type { ProviderUsageRow } from '../../../shared/provider-usage.js';
import { available, unavailable, usageError } from '../result.js';
import { providerHome, readJsonFile, record, stringValue } from './common.js';

export async function fetchOpenCodeUsage(): Promise<
  Omit<ProviderUsageRow, 'checkedAt' | 'label' | 'provider' | 'source'>
> {
  const root = record(await readJsonFile(openCodeAuthPath()));
  const credential = record(root?.deepseek);
  const configured = Boolean(
    stringValue(credential?.key)
      ?? stringValue(credential?.access)
      ?? stringValue(credential?.token),
  );
  if (!configured) {
    return unavailable(
      usageError(
        'not_configured',
        'DeepSeek credential not found. Run `opencode auth login --provider deepseek` to authenticate.',
      ),
    );
  }

  return available(
    [],
    [{ balance: 'Configured', label: 'Credential' }],
    'DeepSeek',
  );
}

export function openCodeAuthPath(): string {
  const testHome = process.env.ANIMA_PROVIDER_USAGE_HOME?.trim();
  const dataHome = testHome
    ? join(testHome, '.local', 'share')
    : process.env.XDG_DATA_HOME?.trim() || join(providerHome(), '.local', 'share');
  return join(dataHome, 'opencode', 'auth.json');
}
