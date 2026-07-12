import { PrivateKey, decrypt, encrypt } from 'eciesjs';

export const HANDOFF_REQUEST_PREFIX = 'asec_req_v1_';
export const HANDOFF_BOX_PREFIX = 'asec_box_v1_';
export const SEALED_HANDOFF_KEY_PREFIX = 'asec_key_v1_';
export const SEALED_HANDOFF_BOX_PREFIX = 'asec_sealed_v1_';
export const MAX_HANDOFF_SECRET_BYTES = 4 * 1024;
export const MAX_HANDOFF_SLACK_PAYLOAD_CHARS = 12_000;
export const DEFAULT_HANDOFF_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const MIN_HANDOFF_EXPIRY_MS = 5 * 60 * 1000;
export const MAX_HANDOFF_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const AGENT_ID = /^[A-Za-z0-9._-]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
const PUBLIC_KEY = /^[0-9a-f]{66}$/;
const PRIVATE_KEY = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type HandoffSenderKind = 'agent' | 'any-workspace-agent' | 'human';

interface HandoffRequestBase {
  v: 1;
  requestId: string;
  recipientAgentId: string;
  targetKey: string;
  purpose: string;
  publicKey: string;
  createdAt: string;
  expiresAt: string;
}

export type HandoffRequest =
  | (HandoffRequestBase & {
      senderKind: 'agent';
      expectedSenderAgentId: string;
    })
  | (HandoffRequestBase & {
      senderKind: 'any-workspace-agent';
    })
  | (HandoffRequestBase & {
      senderKind: 'human';
      workspaceId: string;
      workspaceName: string;
    });

export interface HandoffBox {
  v: 1;
  requestId: string;
  ciphertext: string;
}

export type HandoffSecretPayload =
  | {
      v: 1;
      requestId: string;
      requestDigest: string;
      recipientAgentId: string;
      senderKind: 'agent';
      senderAgentId: string;
      targetKey: string;
      value: string;
      createdAt: string;
    }
  | {
      v: 1;
      requestId: string;
      requestDigest: string;
      recipientAgentId: string;
      senderKind: 'human';
      targetKey: string;
      value: string;
      createdAt: string;
    };

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

export interface CreateHandoffRequestInput {
  recipientAgentId: string;
  targetKey: string;
  purpose: string;
  sender:
    | { kind: 'agent'; agentId: string }
    | { kind: 'any-workspace-agent' }
    | { kind: 'human'; workspaceId: string; workspaceName: string };
  expiresAt: Date;
  now?: Date;
  requestId?: string;
  publicKey: string;
}

export interface EncryptHandoffSecretInput {
  sender: { kind: 'agent'; agentId: string } | { kind: 'human' };
  value: string;
  now?: Date;
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

export function randomHandoffRequestId(): string {
  const bytes = new Uint8Array(16);
  let id: string;
  do {
    crypto.getRandomValues(bytes);
    id = base64UrlEncode(bytes);
  } while (id.startsWith('-'));
  return id;
}

export function createHandoffRequest(
  input: CreateHandoffRequestInput,
): HandoffRequest {
  const now = input.now ?? new Date();
  const base: HandoffRequestBase = {
    v: 1,
    requestId: input.requestId ?? randomHandoffRequestId(),
    recipientAgentId: input.recipientAgentId,
    targetKey: input.targetKey,
    purpose: input.purpose,
    publicKey: input.publicKey,
    createdAt: now.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
  const request: HandoffRequest =
    input.sender.kind === 'agent'
      ? {
          ...base,
          senderKind: 'agent',
          expectedSenderAgentId: input.sender.agentId,
        }
      : input.sender.kind === 'human'
        ? {
            ...base,
            senderKind: 'human',
            workspaceId: input.sender.workspaceId,
            workspaceName: input.sender.workspaceName,
          }
        : { ...base, senderKind: input.sender.kind };
  return validateRequest(request);
}

export function encodeHandoffRequest(request: HandoffRequest): string {
  const canonical = canonicalRequest(validateRequest(request));
  return `${HANDOFF_REQUEST_PREFIX}${base64UrlEncode(encoder.encode(JSON.stringify(canonical)))}`;
}

export function parseHandoffRequest(input: string): HandoffRequest {
  const code = unwrapCode(input, HANDOFF_REQUEST_PREFIX);
  const encoded = code.slice(HANDOFF_REQUEST_PREFIX.length);
  const parsed = parseJsonObject(base64UrlDecode(encoded), 'handoff request');
  const request = validateRequest(parsed);
  if (encodeHandoffRequest(request) !== code) {
    throw new Error('Handoff request is not canonically encoded');
  }
  return request;
}

export function encodeHandoffBox(box: HandoffBox): string {
  const canonical = canonicalBox(validateBox(box));
  return `${HANDOFF_BOX_PREFIX}${base64UrlEncode(encoder.encode(JSON.stringify(canonical)))}`;
}

export function parseHandoffBox(input: string): HandoffBox {
  const code = unwrapCode(input, HANDOFF_BOX_PREFIX);
  const encoded = code.slice(HANDOFF_BOX_PREFIX.length);
  const parsed = parseJsonObject(base64UrlDecode(encoded), 'handoff box');
  const box = validateBox(parsed);
  if (encodeHandoffBox(box) !== code) {
    throw new Error('Handoff box is not canonically encoded');
  }
  return box;
}

export async function handoffRequestDigest(
  request: HandoffRequest,
): Promise<string> {
  const canonical = encoder.encode(
    JSON.stringify(canonicalRequest(validateRequest(request))),
  );
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', canonical)));
}

export async function encryptHandoffSecret(
  request: HandoffRequest,
  input: EncryptHandoffSecretInput,
): Promise<string> {
  validateRequestNotExpired(request);
  assertHandoffSenderForRequest(request, input.sender);
  assertSecretValue(input.value);
  const common = {
    v: 1 as const,
    requestId: request.requestId,
    requestDigest: await handoffRequestDigest(request),
    recipientAgentId: request.recipientAgentId,
    targetKey: request.targetKey,
    value: input.value,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  const payload: HandoffSecretPayload =
    input.sender.kind === 'agent'
      ? { ...common, senderKind: 'agent', senderAgentId: input.sender.agentId }
      : { ...common, senderKind: 'human' };
  const plaintext = encoder.encode(
    JSON.stringify(canonicalPayload(validatePayload(payload))),
  );
  const ciphertext = encrypt(request.publicKey, plaintext);
  const code = encodeHandoffBox({
    v: 1,
    requestId: request.requestId,
    ciphertext: base64UrlEncode(ciphertext),
  });
  assertSlackPayloadSize(code);
  return code;
}

export async function decryptHandoffSecret(
  request: HandoffRequest,
  privateKey: string,
  boxInput: string,
): Promise<HandoffSecretPayload> {
  validateRequest(request);
  validateRequestNotExpired(request);
  if (!PRIVATE_KEY.test(privateKey))
    throw new Error('Pending handoff private key is invalid');
  const box = parseHandoffBox(boxInput);
  if (box.requestId !== request.requestId)
    throw new Error('Handoff box request id does not match');
  let plaintext: Uint8Array;
  try {
    plaintext = decrypt(privateKey, base64UrlDecode(box.ciphertext));
  } catch {
    throw new Error('Handoff box could not be decrypted or was tampered with');
  }
  const payload = validatePayload(
    parseJsonObject(plaintext, 'handoff secret payload'),
  );
  await assertPayloadMatchesRequest(request, payload);
  return payload;
}

export async function handoffSecretFingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(value)),
  );
  return hex(digest).slice(0, 8);
}

export function formatHandoffBoxForSlack(boxCode: string): string {
  const code = unwrapCode(boxCode, HANDOFF_BOX_PREFIX);
  const formatted = `\`\`\`\n${code}\n\`\`\``;
  if (formatted.length >= MAX_HANDOFF_SLACK_PAYLOAD_CHARS) {
    throw new Error(
      `Encrypted handoff exceeds ${MAX_HANDOFF_SLACK_PAYLOAD_CHARS - 1} Slack characters`,
    );
  }
  return formatted;
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

export function formatHandoffRequestForSlack(requestCode: string): string {
  const code = unwrapCode(requestCode, HANDOFF_REQUEST_PREFIX);
  return `\`\`\`\n${code}\n\`\`\``;
}

export function validateRequestNotExpired(
  request: HandoffRequest,
  now: Date = new Date(),
): void {
  if (Date.parse(request.expiresAt) <= now.getTime())
    throw new Error('Handoff request has expired');
}

export function assertHandoffSecretValue(value: string): void {
  assertSecretValue(value);
}

async function assertPayloadMatchesRequest(
  request: HandoffRequest,
  payload: HandoffSecretPayload,
): Promise<void> {
  if (payload.requestId !== request.requestId)
    throw new Error('Handoff payload request id does not match');
  if (payload.requestDigest !== (await handoffRequestDigest(request))) {
    throw new Error('Handoff payload request digest does not match');
  }
  if (payload.recipientAgentId !== request.recipientAgentId) {
    throw new Error('Handoff payload recipient does not match');
  }
  if (payload.targetKey !== request.targetKey)
    throw new Error('Handoff payload target key does not match');
  const payloadCreatedAt = Date.parse(payload.createdAt);
  if (
    payloadCreatedAt < Date.parse(request.createdAt) ||
    payloadCreatedAt > Date.parse(request.expiresAt)
  ) {
    throw new Error(
      'Handoff payload timestamp is outside the request lifetime',
    );
  }
  if (request.senderKind === 'human') {
    if (payload.senderKind !== 'human')
      throw new Error('Handoff payload sender kind does not match');
    return;
  }
  if (payload.senderKind !== 'agent')
    throw new Error('Handoff payload sender kind does not match');
  if (
    request.senderKind === 'agent' &&
    payload.senderAgentId !== request.expectedSenderAgentId
  ) {
    throw new Error('Handoff payload sender does not match');
  }
}

export function assertHandoffSenderForRequest(
  request: HandoffRequest,
  sender: EncryptHandoffSecretInput['sender'],
): void {
  if (request.senderKind === 'human') {
    if (sender.kind !== 'human')
      throw new Error('This handoff request is for a human sender');
    return;
  }
  if (sender.kind !== 'agent')
    throw new Error('This handoff request is for an agent sender');
  assertAgentId(sender.agentId, 'sender agent id');
  if (
    request.senderKind === 'agent' &&
    sender.agentId !== request.expectedSenderAgentId
  ) {
    throw new Error(
      `Handoff request expects sender ${request.expectedSenderAgentId}`,
    );
  }
}

function validateRequest(value: unknown): HandoffRequest {
  const object = asObject(value, 'handoff request');
  const senderKind = requiredString(object, 'senderKind');
  const commonKeys = [
    'createdAt',
    'expiresAt',
    'publicKey',
    'purpose',
    'recipientAgentId',
    'requestId',
    'senderKind',
    'targetKey',
    'v',
  ];
  const expectedKeys =
    senderKind === 'agent'
      ? [...commonKeys, 'expectedSenderAgentId']
      : senderKind === 'human'
        ? [...commonKeys, 'workspaceId', 'workspaceName']
        : commonKeys;
  assertExactKeys(object, expectedKeys, 'handoff request');
  if (object.v !== 1) throw new Error('Unsupported handoff request version');
  if (!['agent', 'any-workspace-agent', 'human'].includes(senderKind)) {
    throw new Error('Handoff request sender kind is invalid');
  }
  const requestId = requiredString(object, 'requestId');
  if (!REQUEST_ID.test(requestId))
    throw new Error('Handoff request id is invalid');
  const recipientAgentId = requiredString(object, 'recipientAgentId');
  assertAgentId(recipientAgentId, 'recipient agent id');
  const targetKey = requiredString(object, 'targetKey');
  if (!ENV_KEY.test(targetKey))
    throw new Error('Handoff target key is invalid');
  const purpose = requiredString(object, 'purpose');
  if (purpose.length > 500)
    throw new Error('Handoff purpose exceeds 500 characters');
  const publicKey = requiredString(object, 'publicKey');
  if (!PUBLIC_KEY.test(publicKey))
    throw new Error('Handoff public key is invalid');
  const createdAt = requiredTimestamp(object, 'createdAt');
  const expiresAt = requiredTimestamp(object, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw new Error('Handoff expiry must be after creation');
  }
  const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
  if (lifetime < MIN_HANDOFF_EXPIRY_MS || lifetime > MAX_HANDOFF_EXPIRY_MS) {
    throw new Error('Handoff lifetime must be between 5m and 7d');
  }
  const base: HandoffRequestBase = {
    v: 1,
    requestId,
    recipientAgentId,
    targetKey,
    purpose,
    publicKey,
    createdAt,
    expiresAt,
  };
  if (senderKind === 'agent') {
    const expectedSenderAgentId = requiredString(
      object,
      'expectedSenderAgentId',
    );
    assertAgentId(expectedSenderAgentId, 'expected sender agent id');
    return { ...base, senderKind, expectedSenderAgentId };
  }
  if (senderKind === 'human') {
    const workspaceId = requiredString(object, 'workspaceId');
    const workspaceName = requiredString(object, 'workspaceName');
    if (workspaceId.length > 100 || workspaceName.length > 200) {
      throw new Error('Handoff workspace metadata is too long');
    }
    return { ...base, senderKind, workspaceId, workspaceName };
  }
  if (senderKind === 'any-workspace-agent') {
    return { ...base, senderKind };
  }
  throw new Error('Handoff request sender kind is invalid');
}

function validateBox(value: unknown): HandoffBox {
  const object = asObject(value, 'handoff box');
  assertExactKeys(object, ['ciphertext', 'requestId', 'v'], 'handoff box');
  if (object.v !== 1) throw new Error('Unsupported handoff box version');
  const requestId = requiredString(object, 'requestId');
  if (!REQUEST_ID.test(requestId))
    throw new Error('Handoff box request id is invalid');
  const ciphertext = requiredString(object, 'ciphertext');
  base64UrlDecode(ciphertext);
  return { v: 1, requestId, ciphertext };
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

function validatePayload(value: unknown): HandoffSecretPayload {
  const object = asObject(value, 'handoff secret payload');
  const senderKind = requiredString(object, 'senderKind');
  const commonKeys = [
    'createdAt',
    'recipientAgentId',
    'requestDigest',
    'requestId',
    'senderKind',
    'targetKey',
    'v',
    'value',
  ];
  const expectedKeys =
    senderKind === 'agent' ? [...commonKeys, 'senderAgentId'] : commonKeys;
  assertExactKeys(object, expectedKeys, 'handoff secret payload');
  if (object.v !== 1)
    throw new Error('Unsupported handoff secret payload version');
  if (senderKind !== 'agent' && senderKind !== 'human') {
    throw new Error('Handoff secret sender kind is invalid');
  }
  const requestId = requiredString(object, 'requestId');
  if (!REQUEST_ID.test(requestId))
    throw new Error('Handoff secret request id is invalid');
  const requestDigest = requiredString(object, 'requestDigest');
  if (!SHA256.test(requestDigest))
    throw new Error('Handoff secret request digest is invalid');
  const recipientAgentId = requiredString(object, 'recipientAgentId');
  assertAgentId(recipientAgentId, 'handoff secret recipient agent id');
  const targetKey = requiredString(object, 'targetKey');
  if (!ENV_KEY.test(targetKey))
    throw new Error('Handoff secret target key is invalid');
  const secret = requiredString(object, 'value', true);
  assertSecretValue(secret);
  const createdAt = requiredTimestamp(object, 'createdAt');
  const common = {
    v: 1 as const,
    requestId,
    requestDigest,
    recipientAgentId,
    targetKey,
    value: secret,
    createdAt,
  };
  if (senderKind === 'agent') {
    const senderAgentId = requiredString(object, 'senderAgentId');
    assertAgentId(senderAgentId, 'handoff secret sender agent id');
    return { ...common, senderKind, senderAgentId };
  }
  return { ...common, senderKind };
}

function canonicalRequest(request: HandoffRequest): Record<string, unknown> {
  if (request.senderKind === 'agent') {
    return {
      v: 1,
      requestId: request.requestId,
      recipientAgentId: request.recipientAgentId,
      senderKind: request.senderKind,
      expectedSenderAgentId: request.expectedSenderAgentId,
      targetKey: request.targetKey,
      purpose: request.purpose,
      publicKey: request.publicKey,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    };
  }
  if (request.senderKind === 'human') {
    return {
      v: 1,
      requestId: request.requestId,
      recipientAgentId: request.recipientAgentId,
      senderKind: request.senderKind,
      workspaceId: request.workspaceId,
      workspaceName: request.workspaceName,
      targetKey: request.targetKey,
      purpose: request.purpose,
      publicKey: request.publicKey,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    };
  }
  return {
    v: 1,
    requestId: request.requestId,
    recipientAgentId: request.recipientAgentId,
    senderKind: request.senderKind,
    targetKey: request.targetKey,
    purpose: request.purpose,
    publicKey: request.publicKey,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

function canonicalBox(box: HandoffBox): Record<string, unknown> {
  return { v: 1, requestId: box.requestId, ciphertext: box.ciphertext };
}

function canonicalSealedBox(box: SealedHandoffBox): Record<string, unknown> {
  return { v: 1, publicKey: box.publicKey, ciphertext: box.ciphertext };
}

function canonicalPayload(
  payload: HandoffSecretPayload,
): Record<string, unknown> {
  const common = {
    v: 1,
    requestId: payload.requestId,
    requestDigest: payload.requestDigest,
    recipientAgentId: payload.recipientAgentId,
    senderKind: payload.senderKind,
  };
  return payload.senderKind === 'agent'
    ? {
        ...common,
        senderAgentId: payload.senderAgentId,
        targetKey: payload.targetKey,
        value: payload.value,
        createdAt: payload.createdAt,
      }
    : {
        ...common,
        targetKey: payload.targetKey,
        value: payload.value,
        createdAt: payload.createdAt,
      };
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

function assertSlackPayloadSize(code: string): void {
  formatHandoffBoxForSlack(code);
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

function requiredTimestamp(
  object: Record<string, unknown>,
  key: string,
): string {
  const value = requiredString(object, key);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !value.endsWith('Z'))
    throw new Error(`${key} is not a UTC timestamp`);
  if (new Date(timestamp).toISOString() !== value)
    throw new Error(`${key} is not a canonical UTC timestamp`);
  return value;
}

function assertAgentId(value: string, label: string): void {
  if (!AGENT_ID.test(value)) throw new Error(`${label} is invalid`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
