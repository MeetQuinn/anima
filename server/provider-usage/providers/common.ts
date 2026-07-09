import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ProviderUsageWindow } from '../../../shared/provider-usage.js';

export function providerHome(): string {
  return process.env.ANIMA_PROVIDER_USAGE_HOME?.trim() || homedir();
}

export async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function homePath(...parts: string[]): string {
  return join(providerHome(), ...parts);
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function epochSecondsFromValue(value: unknown): number | undefined {
  const numeric = numberValue(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
}

export function expiresSoon(value: unknown, skewSeconds = 60, nowMs: number = Date.now()): boolean {
  const expiresAt = epochSecondsFromValue(value);
  if (expiresAt === undefined) return false;
  return expiresAt <= (nowMs / 1000) + skewSeconds;
}

export function jwtExpiresSoon(token: string, skewSeconds = 60, nowMs: number = Date.now()): boolean {
  const claims = decodeJwtPayload(token);
  return expiresSoon(record(claims)?.exp, skewSeconds, nowMs);
}

export function decodeJwtPayload(token: string): unknown | undefined {
  const [, payload] = token.split('.');
  if (!payload) return undefined;
  try {
    const normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function resetAtFromSeconds(seconds: number | undefined, nowMs: number = Date.now()): string | undefined {
  if (seconds === undefined || seconds < 0) return undefined;
  return new Date(nowMs + seconds * 1000).toISOString();
}

export function resetAtFromValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return resetAtFromEpoch(numeric);
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return resetAtFromEpoch(value);
  return undefined;
}

export function windowFromUsedPercent(
  label: string,
  usedPercent: number | undefined,
  input: { resetsAt?: string; resetAfterSeconds?: number; windowSeconds?: number } = {},
): ProviderUsageWindow | undefined {
  if (usedPercent === undefined) return undefined;
  return {
    label,
    remainingPercent: clampPercent(100 - usedPercent),
    ...(input.resetsAt ? { resetsAt: input.resetsAt } : {}),
    ...(input.resetAfterSeconds !== undefined ? { resetsAt: resetAtFromSeconds(input.resetAfterSeconds) } : {}),
    usedPercent: clampPercent(usedPercent),
    ...(input.windowSeconds ? { windowSeconds: input.windowSeconds } : {}),
  };
}

function resetAtFromEpoch(value: number): string | undefined {
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}
