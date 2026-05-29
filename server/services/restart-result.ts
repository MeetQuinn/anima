import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  LastServicesRestart,
  ServicesRestartSucceededResult,
  type LastServicesRestart as LastServicesRestartType,
  type ServicesRestartBlockedResult,
  type ServicesRestartSucceededResult as ServicesRestartSucceededResultType,
} from '../../shared/server-info.js';
import { restartBlockerInfo, type RestartBlockedError } from './restart-gate.js';

export type ServicesRestartSucceededDraft = Omit<ServicesRestartSucceededResultType, 'completedAt'>;
export type ServicesRestartBlockedDraft = Omit<ServicesRestartBlockedResult, 'completedAt'>;
export type ServicesRestartResultDraft = ServicesRestartBlockedDraft | ServicesRestartSucceededDraft;
export type ServicesRestartSummary = Pick<
  ServicesRestartSucceededResultType,
  'fallbackToIdle' | 'mode' | 'requestedCount' | 'resumedCount'
>;

export function servicesRestartLogPath(animaHome: string): string {
  return join(animaHome, 'logs', 'services-restart.log');
}

export function servicesRestartResultPath(animaHome: string): string {
  return join(animaHome, 'run', 'services-restart-result.json');
}

export function idleServicesRestartResult(): ServicesRestartSucceededDraft {
  return {
    fallbackToIdle: false,
    mode: 'idle',
    requestedCount: 0,
    resumedCount: 0,
    status: 'succeeded',
  };
}

export function blockedServicesRestartResult(error: RestartBlockedError): ServicesRestartBlockedDraft {
  return {
    blockers: error.blockers.map(restartBlockerInfo),
    message: 'Agents still working — restart did not run. Try again once they reach a safe point.',
    reason: error.reason,
    status: 'blocked',
  };
}

export async function writeServicesRestartResult(
  resultPath: string,
  result: ServicesRestartResultDraft,
  now = new Date(),
): Promise<void> {
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ ...result, completedAt: now.toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

export async function readLastServicesRestart(
  animaHome: string,
): Promise<LastServicesRestartType | undefined> {
  const resultPath = servicesRestartResultPath(animaHome);
  try {
    const raw = JSON.parse(await readFile(resultPath, 'utf8')) as unknown;
    const parsed = LastServicesRestart.safeParse({
      ...recordOrEmpty(raw),
      logPath: servicesRestartLogPath(animaHome),
    });
    if (!parsed.success) {
      console.warn(`Ignoring invalid services restart result at ${resultPath}: ${parsed.error.message}`);
      return undefined;
    }
    return parsed.data;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    console.warn(`Ignoring unreadable services restart result at ${resultPath}: ${errorMessage(error)}`);
    return undefined;
  }
}

export async function readServicesRestartSummary(resultPath: string): Promise<ServicesRestartSummary> {
  const raw = JSON.parse(await readFile(resultPath, 'utf8')) as unknown;
  const parsed = ServicesRestartSucceededResult.safeParse(recordOrEmpty(raw));
  if (!parsed.success) {
    throw new Error(`services restart reported an invalid restart result: ${parsed.error.message}`);
  }
  return {
    fallbackToIdle: parsed.data.fallbackToIdle,
    mode: parsed.data.mode,
    requestedCount: parsed.data.requestedCount,
    resumedCount: parsed.data.resumedCount,
  };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === code,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
