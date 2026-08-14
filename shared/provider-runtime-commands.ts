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

export const ProviderRuntimeArg = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0, 'Runtime arguments cannot be blank')
  .refine((value) => !value.includes('\0'), 'Runtime arguments cannot contain NUL bytes')
  .refine(
    (value) => !value.includes('\n') && !value.includes('\r'),
    'Runtime arguments cannot contain line breaks',
  );
export type ProviderRuntimeArg = z.infer<typeof ProviderRuntimeArg>;

export const ProviderRuntimeArgs = z.array(ProviderRuntimeArg).max(128);
export type ProviderRuntimeArgs = z.infer<typeof ProviderRuntimeArgs>;

export const ProviderRuntimeArgsConfig = z.partialRecord(
  ProviderUsageKind,
  ProviderRuntimeArgs,
);
export type ProviderRuntimeArgsConfig = z.infer<
  typeof ProviderRuntimeArgsConfig
>;

export const ProviderRuntimeCommandRequest = z
  .object({
    args: ProviderRuntimeArgs.optional(),
    command: ProviderRuntimeCommand.nullable(),
    provider: ProviderUsageKind,
  })
  .strict();
export type ProviderRuntimeCommandRequest = z.infer<
  typeof ProviderRuntimeCommandRequest
>;

export const ProviderRuntimeCommandRow = z.object({
  args: ProviderRuntimeArgs,
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

export function effectiveProviderRuntimeArgs(
  provider: ProviderKind,
  args: ProviderRuntimeArgsConfig,
): string[] {
  return [...(args[provider] ?? [])];
}

export function providerRuntimeCommandsResponse(
  commands: ProviderRuntimeCommandsConfig,
  args: ProviderRuntimeArgsConfig = {},
): ProviderRuntimeCommandsResponse {
  return {
    providers: PROVIDER_CATALOG.map((provider) => ({
      args: effectiveProviderRuntimeArgs(provider.kind, args),
      command: commands[provider.kind] ?? null,
      defaultCommand: provider.command,
      provider: provider.kind,
    })),
  };
}
