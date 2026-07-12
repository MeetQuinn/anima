import type { ProviderKind } from '../../shared/provider-catalog.js';
import type {
  ProviderCliInstallSource,
  ProviderCliRow,
} from '../../shared/provider-cli.js';

export interface ResolvedExecutable {
  path: string;
  realPath: string;
  shadowed: boolean;
}

export interface ProviderInspection {
  autoUpdateChannel?: string;
  autoUpdatesEnabled?: boolean;
  binaryPath?: string;
  installSource: ProviderCliInstallSource;
  installedVersion?: string;
  label: string;
  manualCommand?: string;
  npmPath?: string;
  npmPrefix?: string;
  provider: ProviderKind;
  realPath?: string;
  restoreCommand?: string;
  sourceDetail?: string;
  updateCommand?: { args: string[]; command: string };
  updateMode: ProviderCliRow['updateMode'];
}

export type ProviderCliCommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stderr: string; stdout: string }>;
