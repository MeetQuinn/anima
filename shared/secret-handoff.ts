import { PrivateKey, decrypt, encrypt } from 'eciesjs';

export const SEALED_HANDOFF_KEY_PREFIX = 'asec_key_v1_';
export const SEALED_HANDOFF_BOX_PREFIX = 'asec_sealed_v1_';
export const MAX_HANDOFF_SECRET_BYTES = 4 * 1024;
export const MAX_HANDOFF_SLACK_PAYLOAD_CHARS = 12_000;
export const DEFAULT_HANDOFF_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const MIN_HANDOFF_EXPIRY_MS = 5 * 60 * 1000;
export const MAX_HANDOFF_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const PUBLIC_KEY = /^[0-9a-f]{66}$/;
const PRIVATE_KEY = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface HandoffKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface SealedHandoffBox {
  v: 1;
  publicKey: string;
  ciphertext: string;
}

export interface SealedHandoffSecretPayload {
  v: 1;
  value: string;
}

export function createHandoffKeyPair(): HandoffKeyPair {
  const privateKey = new PrivateKey();
  return {
    privateKey: privateKey.toHex(),
    publicKey: privateKey.publicKey.toHex(),
  };
}

export function encodeSealedHandoffPublicKey(publicKey: string): string {
  if (!PUBLIC_KEY.test(publicKey))
    throw new Error('Sealed handoff public key is invalid');
  return `${SEALED_HANDOFF_KEY_PREFIX}${publicKey}`;
}

export function parseSealedHandoffPublicKey(input: string): string {
  const code = unwrapCode(input, SEALED_HANDOFF_KEY_PREFIX);
  const publicKey = code.slice(SEALED_HANDOFF_KEY_PREFIX.length);
  if (!PUBLIC_KEY.test(publicKey))
    throw new Error('Sealed handoff public key is invalid');
  if (encodeSealedHandoffPublicKey(publicKey) !== code)
    throw new Error('Sealed handoff public key is not canonically encoded');
  return publicKey;
}

export async function sealedHandoffKeyId(publicKey: string): Promise<string> {
  const canonical = parseSealedHandoffPublicKey(encodeSealedHandoffPublicKey(publicKey));
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(canonical)),
  );
  return `s_${base64UrlEncode(digest).slice(0, 22)}`;
}

export function encodeSealedHandoffBox(box: SealedHandoffBox): string {
  const canonical = canonicalSealedBox(validateSealedBox(box));
  return `${SEALED_HANDOFF_BOX_PREFIX}${base64UrlEncode(
    encoder.encode(JSON.stringify(canonical)),
  )}`;
}

export function parseSealedHandoffBox(input: string): SealedHandoffBox {
  const code = unwrapCode(input, SEALED_HANDOFF_BOX_PREFIX);
  const encoded = code.slice(SEALED_HANDOFF_BOX_PREFIX.length);
  const parsed = parseJsonObject(base64UrlDecode(encoded), 'sealed handoff box');
  const box = validateSealedBox(parsed);
  if (encodeSealedHandoffBox(box) !== code)
    throw new Error('Sealed handoff box is not canonically encoded');
  return box;
}

export async function encryptSealedHandoffSecret(
  publicKeyInput: string,
  value: string,
): Promise<string> {
  const publicKey = parseSealedHandoffPublicKey(publicKeyInput);
  assertSecretValue(value);
  const payload: SealedHandoffSecretPayload = { v: 1, value };
  const plaintext = encoder.encode(JSON.stringify(payload));
  const code = encodeSealedHandoffBox({
    v: 1,
    publicKey,
    ciphertext: base64UrlEncode(encrypt(publicKey, plaintext)),
  });
  assertSealedSlackPayloadSize(code);
  return code;
}

export function decryptSealedHandoffSecret(
  privateKey: string,
  boxInput: string,
): SealedHandoffSecretPayload {
  if (!PRIVATE_KEY.test(privateKey))
    throw new Error('Pending sealed handoff private key is invalid');
  const box = parseSealedHandoffBox(boxInput);
  let plaintext: Uint8Array;
  try {
    plaintext = decrypt(privateKey, base64UrlDecode(box.ciphertext));
  } catch {
    throw new Error('Sealed handoff box could not be decrypted or was tampered with');
  }
  return validateSealedPayload(parseJsonObject(plaintext, 'sealed handoff secret payload'));
}

export async function handoffSecretFingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(value)),
  );
  return hex(digest).slice(0, 8);
}

export function formatSealedHandoffBoxForSlack(boxCode: string): string {
  const code = unwrapCode(boxCode, SEALED_HANDOFF_BOX_PREFIX);
  const formatted = `\`\`\`\n${code}\n\`\`\``;
  if (formatted.length >= MAX_HANDOFF_SLACK_PAYLOAD_CHARS) {
    throw new Error(
      `Encrypted handoff exceeds ${MAX_HANDOFF_SLACK_PAYLOAD_CHARS - 1} Slack characters`,
    );
  }
  return formatted;
}

function validateSealedBox(value: unknown): SealedHandoffBox {
  const object = asObject(value, 'sealed handoff box');
  assertExactKeys(object, ['ciphertext', 'publicKey', 'v'], 'sealed handoff box');
  if (object.v !== 1) throw new Error('Unsupported sealed handoff box version');
  const publicKey = requiredString(object, 'publicKey');
  if (!PUBLIC_KEY.test(publicKey))
    throw new Error('Sealed handoff box public key is invalid');
  const ciphertext = requiredString(object, 'ciphertext');
  base64UrlDecode(ciphertext);
  return { v: 1, publicKey, ciphertext };
}

function validateSealedPayload(value: unknown): SealedHandoffSecretPayload {
  const object = asObject(value, 'sealed handoff secret payload');
  assertExactKeys(object, ['v', 'value'], 'sealed handoff secret payload');
  if (object.v !== 1)
    throw new Error('Unsupported sealed handoff secret payload version');
  const secret = requiredString(object, 'value', true);
  assertSecretValue(secret);
  return { v: 1, value: secret };
}

function canonicalSealedBox(box: SealedHandoffBox): Record<string, unknown> {
  return { v: 1, publicKey: box.publicKey, ciphertext: box.ciphertext };
}

function assertSecretValue(value: string): void {
  const length = encoder.encode(value).byteLength;
  if (length === 0) throw new Error('Handoff secret value is required');
  if (length > MAX_HANDOFF_SECRET_BYTES) {
    throw new Error(
      `Handoff secret exceeds ${MAX_HANDOFF_SECRET_BYTES} UTF-8 bytes`,
    );
  }
}

function assertSealedSlackPayloadSize(code: string): void {
  formatSealedHandoffBoxForSlack(code);
}

function unwrapCode(input: string, prefix: string): string {
  const trimmed = input.trim();
  const fenced = trimmed.match(/^```(?:text)?\s*\n([\s\S]*?)\n```$/);
  const code = (fenced?.[1] ?? trimmed).trim();
  if (!code.startsWith(prefix))
    throw new Error(`Expected ${prefix} handoff code`);
  if (code.length >= MAX_HANDOFF_SLACK_PAYLOAD_CHARS)
    throw new Error('Handoff code is too large');
  if (/\s/.test(code)) throw new Error('Handoff code contains whitespace');
  return code;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Invalid base64url value');
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Invalid base64url value');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value)
    throw new Error('Non-canonical base64url value');
  return bytes;
}

function parseJsonObject(
  bytes: Uint8Array,
  label: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(`Invalid ${label} JSON`);
  }
  return asObject(value, label);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  object: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} fields are invalid`);
  }
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
  allowEmpty = false,
): string {
  const value = object[key];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${key} must be a${allowEmpty ? '' : ' non-empty'} string`);
  }
  return value;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
