import { isAbsolute } from 'node:path';

import {
  providerRuntimeCommandsResponse,
  type ProviderRuntimeCommandRequest,
  type ProviderRuntimeCommandsConfig,
  type ProviderRuntimeCommandsResponse,
} from '../../shared/provider-runtime-commands.js';
import { providerCatalogEntry } from '../../shared/provider-catalog.js';
import type { ProviderUsageKind } from '../../shared/provider-usage.js';
import { resolveProviderExecutable } from '../provider-cli/provider-inspection.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';

interface ProviderRuntimeCommandSettings {
  getProviderRuntimeCommands(): Promise<ProviderRuntimeCommandsConfig>;
  setProviderRuntimeCommand(
    provider: ProviderUsageKind,
    command: string | null,
  ): Promise<ProviderRuntimeCommandsConfig>;
}

interface ProviderRuntimeCommandServiceOptions {
  env?: NodeJS.ProcessEnv;
  settings?: ProviderRuntimeCommandSettings;
}

export class ProviderRuntimeCommandError extends Error {
  constructor(
    readonly statusCode: 409,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRuntimeCommandError';
  }
}

export class ProviderRuntimeCommandService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly settings: ProviderRuntimeCommandSettings;

  constructor(options: ProviderRuntimeCommandServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.settings = options.settings ?? defaultServerSettingsService;
  }

  async status(): Promise<ProviderRuntimeCommandsResponse> {
    return providerRuntimeCommandsResponse(
      await this.settings.getProviderRuntimeCommands(),
    );
  }

  async set(
    input: ProviderRuntimeCommandRequest,
  ): Promise<ProviderRuntimeCommandsResponse> {
    const command =
      input.command === providerCatalogEntry(input.provider)?.command
        ? null
        : input.command;
    if (
      command !== null &&
      (command.includes('/') || command.includes('\\')) &&
      !isAbsolute(command)
    ) {
      throw new ProviderRuntimeCommandError(
        409,
        'Runtime command paths must be absolute',
      );
    }
    if (
      command !== null &&
      !(await resolveProviderExecutable(command, this.env))
    ) {
      throw new ProviderRuntimeCommandError(
        409,
        `Runtime command was not found or is not executable: ${command}`,
      );
    }
    const commands = await this.settings.setProviderRuntimeCommand(
      input.provider,
      command,
    );
    return providerRuntimeCommandsResponse(commands);
  }
}

export const defaultProviderRuntimeCommandService =
  new ProviderRuntimeCommandService();
