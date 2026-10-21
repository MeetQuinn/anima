import { isRecord, stringField } from '../json.js';

// Picks the option to answer an ACP `session/request_permission` with: an
// always-allow option first, then any allow option that isn't a rejection.
// CLIs spell options differently, so this matches on the id, kind, type, name,
// label and title together. Returns undefined when no option allows.

export function acpPermissionApprovalOptionId(message: Record<string, unknown>): string | undefined {
  const params = isRecord(message['params']) ? message['params'] : undefined;
  const options = Array.isArray(params?.['options']) ? params['options'].filter(isRecord) : [];
  return (
    findPermissionOptionId(options, isAlwaysAllowPermissionOption) ??
    findPermissionOptionId(options, isAllowPermissionOption)
  );
}

function findPermissionOptionId(
  options: Record<string, unknown>[],
  predicate: (option: Record<string, unknown>) => boolean,
): string | undefined {
  for (const option of options) {
    const optionId = permissionOptionId(option);
    if (!optionId) continue;
    if (predicate(option)) return optionId;
  }
  return undefined;
}

function permissionOptionId(option: Record<string, unknown>): string | undefined {
  return stringField(option, 'optionId') ?? stringField(option, 'option_id') ?? stringField(option, 'id');
}

function isAlwaysAllowPermissionOption(option: Record<string, unknown>): boolean {
  const key = permissionOptionKey(option);
  return /\b(allow|approve)[_-]?(always|session)\b/.test(key) || /\b(always|session)[_-]?(allow|approve)\b/.test(key);
}

function isAllowPermissionOption(option: Record<string, unknown>): boolean {
  const key = permissionOptionKey(option);
  if (/\b(reject|deny|decline|cancel|disallow)\b/.test(key)) return false;
  return /\b(allow|approve|accept|permit)\b/.test(key);
}

function permissionOptionKey(option: Record<string, unknown>): string {
  return [
    permissionOptionId(option),
    stringField(option, 'kind'),
    stringField(option, 'type'),
    stringField(option, 'name'),
    stringField(option, 'label'),
    stringField(option, 'title'),
  ].filter(Boolean).join(' ').toLowerCase().replace(/[^a-z0-9_-]+/g, ' ');
}
