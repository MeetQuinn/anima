import { existsSync, realpathSync } from 'node:fs';

export interface NodePathFs {
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
}

const defaultFs: NodePathFs = {
  exists: existsSync,
  realpath: realpathSync,
};

const HOMEBREW_KEG_NODE = /^(.+)\/Cellar\/(node(?:@[^/]+)?)\/[^/]+\/bin\/node$/;

/**
 * The Node binary a service definition (launchd plist, systemd unit) launches.
 *
 * `process.execPath` is the resolved binary, so a Homebrew Node reports its
 * versioned keg, such as `/opt/homebrew/Cellar/node/25.8.2/bin/node`.
 * Homebrew deletes old kegs during cleanup, which can run after any
 * `brew install`, and a definition pinned to one stops starting at the next
 * restart. Homebrew's `<prefix>/opt/<formula>` link names the same binary
 * without the version, so it is preferred when it resolves to the running
 * binary. When the running keg is already gone, the formula's current Node is
 * the only one left to launch.
 */
export function serviceNodePath(execPath: string = process.execPath, fs: NodePathFs = defaultFs): string {
  const keg = HOMEBREW_KEG_NODE.exec(execPath);
  if (!keg) return execPath;
  const optPath = `${keg[1]}/opt/${keg[2]}/bin/node`;
  if (!fs.exists(optPath)) return execPath;
  if (!fs.exists(execPath)) return optPath;
  try {
    return fs.realpath(optPath) === fs.realpath(execPath) ? optPath : execPath;
  } catch {
    return execPath;
  }
}

/**
 * The Node binary an installed service definition launches, when it names one
 * that no longer exists. Such a definition can never start, so the caller
 * rewrites it before starting. Relative or unparsed values are left alone.
 */
export function missingDefinitionNode(
  definitionNode: string | undefined,
  fs: Pick<NodePathFs, 'exists'> = defaultFs,
): string | undefined {
  if (!definitionNode || !definitionNode.startsWith('/')) return undefined;
  return fs.exists(definitionNode) ? undefined : definitionNode;
}

/**
 * How long a started service must keep the same pid before a start counts.
 * Service managers report a pid as soon as they spawn the program, even when
 * it then fails to exec (a missing Node binary) or exits during boot, and
 * KeepAlive or Restart=always then respawns it under a new pid.
 */
export const SERVICE_START_SETTLE_MS = 2_000;

export interface StartedServiceStatus {
  pid?: number;
  running: boolean;
}

/**
 * Wait out the settle window and confirm the service still runs as the pid it
 * started with. Throws otherwise, so a restart or upgrade reports the failure
 * instead of a service that is already gone.
 */
export async function confirmServiceStayedUp<T extends StartedServiceStatus>(input: {
  describe: string;
  logPath: string;
  read: () => Promise<T>;
  settleMs?: number;
  started: T;
}): Promise<T> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, input.settleMs ?? SERVICE_START_SETTLE_MS));
  const settled = await input.read();
  if (settled.running && settled.pid === input.started.pid) return settled;
  const now = settled.running && settled.pid !== undefined ? `now pid ${settled.pid}` : 'now stopped';
  throw new Error(
    `${input.describe} exited right after start (started as pid ${input.started.pid ?? 'unknown'}, ${now}); see ${input.logPath}`,
  );
}
