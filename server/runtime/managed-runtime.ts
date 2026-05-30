import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_RUNTIME_PACKAGE = '@meetquinn/animactl';
export const RUNTIME_METADATA_VERSION = 1;

export interface RuntimePathOptions {
  packageName?: string;
  runtimeDir?: string;
}

export interface RuntimePaths {
  animaBin: string;
  animactlBin: string;
  animactlScript: string;
  metadataPath: string;
  packageDir: string;
  packageJsonPath: string;
  runtimeDir: string;
  wrapperPackageJsonPath: string;
}

export interface RuntimeInstallOptions extends RuntimePathOptions {
  channel?: string;
  npmCommand?: string;
  runner?: RuntimeInstallRunner;
  version?: string;
}

export interface RuntimeInstallResult {
  installed: boolean;
  metadata: RuntimeMetadata;
  paths: RuntimePaths;
  stderr: string;
  stdout: string;
}

export interface RuntimeMetadata {
  installedAt: string;
  packageDir: string;
  packageName: string;
  requested: string;
  runtimeDir: string;
  schemaVersion: typeof RUNTIME_METADATA_VERSION;
  specifier: string;
  version: string;
}

export interface RuntimeStatus {
  installed: boolean;
  metadata?: RuntimeMetadata;
  packageName: string;
  paths: RuntimePaths;
  version?: string;
}

export interface RuntimePackageInfo {
  name: string;
  rootDir: string;
  version: string;
}

export type RuntimeInstallRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stderr: string; stdout: string }>;

interface PackageSpecifierInput {
  channel?: string;
  packageName?: string;
  version?: string;
}

export function resolveManagedAnimaHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ANIMA_HOME?.trim();
  return explicit ? resolve(explicit) : join(homedir(), '.anima');
}

export function managedRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const packageName = options.packageName ?? DEFAULT_RUNTIME_PACKAGE;
  const runtimeDir = resolve(options.runtimeDir ?? defaultRuntimeDir());
  const packageDir = join(runtimeDir, 'node_modules', ...packageNameParts(packageName));
  return {
    animaBin: join(runtimeDir, 'node_modules', '.bin', process.platform === 'win32' ? 'anima.cmd' : 'anima'),
    animactlBin: join(runtimeDir, 'node_modules', '.bin', process.platform === 'win32' ? 'animactl.cmd' : 'animactl'),
    animactlScript: join(packageDir, 'dist', 'server', 'cli', 'animactl.js'),
    metadataPath: join(runtimeDir, '.anima-runtime.json'),
    packageDir,
    packageJsonPath: join(packageDir, 'package.json'),
    runtimeDir,
    wrapperPackageJsonPath: join(runtimeDir, 'package.json'),
  };
}

export function defaultRuntimeDir(animaHome = resolveManagedAnimaHome()): string {
  return join(animaHome, 'runtime', 'current');
}

export function packageSpecifier(input: PackageSpecifierInput): string {
  const packageName = input.packageName ?? DEFAULT_RUNTIME_PACKAGE;
  if (input.version && input.channel) throw new Error('Choose either --version or --channel, not both.');
  const requested = input.version ?? input.channel ?? 'latest';
  if (!requested.trim()) throw new Error('Runtime package version/channel cannot be empty.');
  return `${packageName}@${requested}`;
}

export async function currentRuntimePackageInfo(): Promise<RuntimePackageInfo> {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const pkg = parseJsonRecord(await readFile(join(rootDir, 'package.json'), 'utf8'));
  const name = stringField(pkg, 'name') ?? DEFAULT_RUNTIME_PACKAGE;
  const version = stringField(pkg, 'version');
  if (!version) throw new Error(`package.json at ${rootDir} is missing a version`);
  return { name, rootDir, version };
}

export async function installManagedRuntime(options: RuntimeInstallOptions = {}): Promise<RuntimeInstallResult> {
  const packageName = options.packageName ?? DEFAULT_RUNTIME_PACKAGE;
  const paths = managedRuntimePaths({ packageName, runtimeDir: options.runtimeDir });
  const specifier = packageSpecifier({
    channel: options.channel,
    packageName,
    version: options.version,
  });
  const requested = options.version ?? options.channel ?? 'latest';

  await mkdir(paths.runtimeDir, { recursive: true });
  await ensureWrapperPackageJson(paths.wrapperPackageJsonPath);

  const runner = options.runner ?? defaultInstallRunner;
  const args = [
    'install',
    '--prefix',
    paths.runtimeDir,
    '--omit=dev',
    '--no-audit',
    '--fund=false',
    specifier,
  ];
  const { stderr, stdout } = await runner(options.npmCommand ?? 'npm', args, {
    cwd: paths.runtimeDir,
    env: process.env,
  });

  const installed = parseJsonRecord(await readFile(paths.packageJsonPath, 'utf8'));
  const version = stringField(installed, 'version');
  if (!version) throw new Error(`Installed runtime package is missing version: ${paths.packageJsonPath}`);

  const metadata: RuntimeMetadata = {
    installedAt: new Date().toISOString(),
    packageDir: paths.packageDir,
    packageName,
    requested,
    runtimeDir: paths.runtimeDir,
    schemaVersion: RUNTIME_METADATA_VERSION,
    specifier,
    version,
  };
  await writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  return { installed: true, metadata, paths, stderr, stdout };
}

export async function ensureManagedRuntime(options: RuntimeInstallOptions = {}): Promise<RuntimeInstallResult> {
  const packageName = options.packageName ?? DEFAULT_RUNTIME_PACKAGE;
  const requested = options.version ?? options.channel ?? 'latest';
  const isExactVersion = Boolean(options.version);
  if (isExactVersion) {
    const status = await readManagedRuntimeStatus({ packageName, runtimeDir: options.runtimeDir });
    if (status.installed && status.version === requested && status.metadata?.specifier === packageSpecifier({ packageName, version: requested })) {
      return {
        installed: false,
        metadata: status.metadata,
        paths: status.paths,
        stderr: '',
        stdout: '',
      };
    }
  }
  return installManagedRuntime(options);
}

export async function readManagedRuntimeStatus(options: RuntimePathOptions = {}): Promise<RuntimeStatus> {
  const packageName = options.packageName ?? DEFAULT_RUNTIME_PACKAGE;
  const paths = managedRuntimePaths({ packageName, runtimeDir: options.runtimeDir });
  if (!existsSync(paths.packageJsonPath) || !existsSync(paths.animactlScript)) {
    return { installed: false, packageName, paths };
  }

  const installed = parseJsonRecord(await readFile(paths.packageJsonPath, 'utf8'));
  const version = stringField(installed, 'version');
  const metadata = existsSync(paths.metadataPath)
    ? runtimeMetadataFromUnknown(JSON.parse(await readFile(paths.metadataPath, 'utf8')))
    : undefined;
  return {
    installed: Boolean(version),
    ...(metadata ? { metadata } : {}),
    packageName,
    paths,
    ...(version ? { version } : {}),
  };
}

function defaultInstallRunner(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ stderr: string; stdout: string }> {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 10 * 1024 * 1024,
  }) as Promise<{ stderr: string; stdout: string }>;
}

async function ensureWrapperPackageJson(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) return;
  await writeFile(
    path,
    `${JSON.stringify({
      private: true,
      name: 'anima-managed-runtime',
      description: 'Local managed runtime cache for Anima services.',
    }, null, 2)}\n`,
    'utf8',
  );
}

function packageNameParts(packageName: string): string[] {
  const parts = packageName.split('/').filter(Boolean);
  if (packageName.startsWith('@') && parts.length === 2 && parts[0]?.startsWith('@')) return parts;
  if (!packageName.startsWith('@') && parts.length === 1) return parts;
  throw new Error(`Invalid npm package name: ${packageName}`);
}

function runtimeMetadataFromUnknown(value: unknown): RuntimeMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const schemaVersion = value['schemaVersion'];
  const installedAt = stringField(value, 'installedAt');
  const packageDir = stringField(value, 'packageDir');
  const packageName = stringField(value, 'packageName');
  const requested = stringField(value, 'requested');
  const runtimeDir = stringField(value, 'runtimeDir');
  const specifier = stringField(value, 'specifier');
  const version = stringField(value, 'version');
  if (
    schemaVersion !== RUNTIME_METADATA_VERSION
    || !installedAt
    || !packageDir
    || !packageName
    || !requested
    || !runtimeDir
    || !specifier
    || !version
  ) {
    return undefined;
  }
  return {
    installedAt,
    packageDir,
    packageName,
    requested,
    runtimeDir,
    schemaVersion: RUNTIME_METADATA_VERSION,
    specifier,
    version,
  };
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error('Expected JSON object');
  return parsed;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
