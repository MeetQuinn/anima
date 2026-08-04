import { z } from 'zod';

import { PROVIDER_CATALOG, providerCatalogEntry } from './provider-catalog.js';
import { ProviderUsageKind, type ProviderUsageKind as ProviderKind } from './provider-usage.js';

export const ProviderRuntimeCommand = z.string().trim().min(1).max(4096);
export type ProviderRuntimeCommand = z.infer<typeof ProviderRuntimeCommand>;

export const ProviderRuntimeCommandsConfig = z.partialRecord(
  ProviderUsageKind,
  ProviderRuntimeCommand,
);
export type ProviderRuntimeCommandsConfig = z.infer<
  typeof ProviderRuntimeCommandsConfig
>;

export const ProviderRuntimeCommandRequest = z
  .object({
    command: ProviderRuntimeCommand.nullable(),
    provider: ProviderUsageKind,
  })
  .strict();
export type ProviderRuntimeCommandRequest = z.infer<
  typeof ProviderRuntimeCommandRequest
>;

export const ProviderRuntimeCommandRow = z.object({
  command: ProviderRuntimeCommand.nullable(),
  defaultCommand: ProviderRuntimeCommand,
  provider: ProviderUsageKind,
});
export type ProviderRuntimeCommandRow = z.infer<
  typeof ProviderRuntimeCommandRow
>;

export const ProviderRuntimeCommandsResponse = z.object({
  providers: z.array(ProviderRuntimeCommandRow),
});
export type ProviderRuntimeCommandsResponse = z.infer<
  typeof ProviderRuntimeCommandsResponse
>;

export function effectiveProviderRuntimeCommand(
  provider: ProviderKind,
  commands: ProviderRuntimeCommandsConfig,
): string {
  return commands[provider] ?? providerCatalogEntry(provider)?.command ?? provider;
}

export function providerRuntimeCommandsResponse(
  commands: ProviderRuntimeCommandsConfig,
): ProviderRuntimeCommandsResponse {
  return {
    providers: PROVIDER_CATALOG.map((provider) => ({
      command: commands[provider.kind] ?? null,
      defaultCommand: provider.command,
      provider: provider.kind,
    })),
  };
}
