import { errorMessage } from '../ids.js';

export type ProviderSessionCorruptionReason = 'missing_tool_output' | 'turn_desync';

export class ProviderSessionCorruptionError extends Error {
  readonly name = 'ProviderSessionCorruptionError';

  constructor(
    readonly providerSessionId: string,
    readonly reason: ProviderSessionCorruptionReason,
    cause: unknown,
  ) {
    super(`Provider session ${providerSessionId} is corrupted (${reason}): ${errorMessage(cause)}`, {
      cause,
    });
  }
}

export function isProviderSessionCorruptionError(
  error: unknown,
): error is ProviderSessionCorruptionError {
  return error instanceof ProviderSessionCorruptionError;
}
