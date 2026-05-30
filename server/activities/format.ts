import { errorMessage } from '../ids.js';

export function truncateForActivity(text: string): string {
  return text.trim().slice(0, 4000);
}

export function runtimeErrorPayload(error: unknown): Record<string, unknown> {
  return {
    error: truncateForActivity(errorMessage(error)),
  };
}

export function copyNumber(
  source: Record<string, unknown> | undefined,
  target: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const value = source?.[from];
  if (typeof value === 'number' && Number.isFinite(value)) target[to] = value;
}

export function copyString(
  source: Record<string, unknown> | undefined,
  target: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const value = source?.[from];
  if (typeof value === 'string' && value) target[to] = value;
}

export function copyBoolean(
  source: Record<string, unknown> | undefined,
  target: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const value = source?.[from];
  if (typeof value === 'boolean') target[to] = value;
}

export function copyActivityPreview(
  source: Record<string, unknown> | undefined,
  target: Record<string, unknown>,
  from: string,
  to: string,
): void {
  const value = source?.[from];
  if (typeof value === 'string' && value) target[to] = truncateForActivity(value);
}

export function isFirstClassAnimaCliCommand(command: string | undefined): boolean {
  const trimmed = command?.trim();
  if (!trimmed) return false;
  const withOptionalEnv = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*`;
  return new RegExp(
    String.raw`^${withOptionalEnv}anima\s+(?:ask|message\s+(?:read|send|update|react)|file\s+send|reminder\s+(?:schedule|cancel|snooze|list)|subscription\s+(?:list|mute))\b`,
  ).test(trimmed);
}
