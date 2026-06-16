import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

import type { IncomingHttpHeaders } from 'node:http';

import type { DashboardAuth } from '../../shared/server-settings.js';
import { defaultServerSettingsService, type ServerSettingsService } from './settings.service.js';

const PASSWORD_HASH_VERSION = 'scrypt:v1';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_BYTES = 32;
const DEFAULT_SESSION_TTL_HOURS = 24 * 14;
export const DASHBOARD_AUTH_COOKIE = 'anima_dashboard_session';

interface DashboardSessionPayload {
  exp: number;
  iat: number;
  nonce: string;
}

export interface DashboardAuthStatus {
  authenticated: boolean;
  enabled: boolean;
  sessionTtlHours: number;
}

export class DashboardAuthService {
  constructor(private readonly settings: ServerSettingsService = defaultServerSettingsService) {}

  async status(headers?: IncomingHttpHeaders): Promise<DashboardAuthStatus> {
    const config = await this.settings.getDashboardAuth();
    const enabled = dashboardAuthEnabled(config);
    return {
      authenticated: enabled ? this.verifySession(headers, config) : true,
      enabled,
      sessionTtlHours: sessionTtlHours(config),
    };
  }

  async setPassword(password: string, options: { sessionTtlHours?: number } = {}): Promise<DashboardAuth> {
    const normalized = normalizePassword(password);
    const previous = await this.settings.getDashboardAuth();
    const next: DashboardAuth = {
      enabled: true,
      passwordHash: await hashDashboardPassword(normalized),
      sessionSecret: newDashboardSessionSecret(),
      sessionTtlHours: options.sessionTtlHours ?? sessionTtlHours(previous),
    };
    return this.settings.setDashboardAuth(next);
  }

  async disable(): Promise<DashboardAuth> {
    return this.settings.setDashboardAuth({ enabled: false });
  }

  async login(
    password: string,
    options: { secureCookie?: boolean } = {},
  ): Promise<{ cookie: string; ok: boolean; status: DashboardAuthStatus }> {
    const config = await this.settings.getDashboardAuth();
    const enabled = dashboardAuthEnabled(config);
    if (!enabled) {
      return {
        cookie: clearDashboardAuthCookie(),
        ok: true,
        status: { authenticated: true, enabled: false, sessionTtlHours: sessionTtlHours(config) },
      };
    }
    if (!config?.passwordHash || !config.sessionSecret) {
      return {
        cookie: clearDashboardAuthCookie(),
        ok: false,
        status: { authenticated: false, enabled: true, sessionTtlHours: sessionTtlHours(config) },
      };
    }
    const ok = await verifyDashboardPassword(password, config.passwordHash);
    return {
      cookie: ok
        ? createDashboardSessionCookie(config.sessionSecret, sessionTtlHours(config), options.secureCookie === true)
        : clearDashboardAuthCookie(),
      ok,
      status: { authenticated: ok, enabled: true, sessionTtlHours: sessionTtlHours(config) },
    };
  }

  async isRequestAuthenticated(headers: IncomingHttpHeaders | undefined): Promise<boolean> {
    const config = await this.settings.getDashboardAuth();
    if (!dashboardAuthEnabled(config)) return true;
    return this.verifySession(headers, config);
  }

  private verifySession(headers: IncomingHttpHeaders | undefined, config: DashboardAuth | undefined): boolean {
    if (!config?.sessionSecret) return false;
    return verifyDashboardSessionCookie(cookieValue(headers, DASHBOARD_AUTH_COOKIE), config.sessionSecret);
  }
}

export const defaultDashboardAuthService = new DashboardAuthService();

export function dashboardAuthEnabled(config: DashboardAuth | undefined): boolean {
  return config?.enabled === true && Boolean(config.passwordHash && config.sessionSecret);
}

export function sessionTtlHours(config: DashboardAuth | undefined): number {
  return config?.sessionTtlHours ?? DEFAULT_SESSION_TTL_HOURS;
}

export function normalizePassword(password: string): string {
  if (!password) throw new Error('password is required');
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  return password;
}

export async function hashDashboardPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await deriveScrypt(password, salt, HASH_BYTES, { N: SCRYPT_N, p: SCRYPT_P, r: SCRYPT_R });
  return [
    PASSWORD_HASH_VERSION,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    Buffer.from(hash).toString('base64url'),
  ].join(':');
}

export async function verifyDashboardPassword(password: string, encodedHash: string): Promise<boolean> {
  const parts = encodedHash.split(':');
  if (parts.length !== 7 || `${parts[0]}:${parts[1]}` !== PASSWORD_HASH_VERSION) return false;
  const [nRaw, rRaw, pRaw, saltRaw, expectedRaw] = parts.slice(2);
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  try {
    const salt = Buffer.from(saltRaw ?? '', 'base64url');
    const expected = Buffer.from(expectedRaw ?? '', 'base64url');
    const actual = await deriveScrypt(password, salt, expected.length || HASH_BYTES, { N: n, p, r });
    return safeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function newDashboardSessionSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function createDashboardSessionCookie(sessionSecret: string, ttlHours: number, secure = false): string {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = Math.max(60, Math.floor(ttlHours * 60 * 60));
  const payload: DashboardSessionPayload = {
    exp: now + maxAge,
    iat: now,
    nonce: randomBytes(16).toString('base64url'),
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = signSession(payloadPart, sessionSecret);
  return serializeCookie(DASHBOARD_AUTH_COOKIE, `${payloadPart}.${signature}`, {
    httpOnly: true,
    maxAge,
    path: '/',
    sameSite: 'Lax',
    secure,
  });
}

export function clearDashboardAuthCookie(): string {
  return serializeCookie(DASHBOARD_AUTH_COOKIE, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'Lax',
  });
}

export function verifyDashboardSessionCookie(value: string | undefined, sessionSecret: string): boolean {
  if (!value) return false;
  const [payloadPart, signature, extra] = value.split('.');
  if (!payloadPart || !signature || extra !== undefined) return false;
  if (!safeEqual(Buffer.from(signature), Buffer.from(signSession(payloadPart, sessionSecret)))) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Partial<DashboardSessionPayload>;
    return typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function cookieValue(headers: IncomingHttpHeaders | undefined, name: string): string | undefined {
  const header = headers?.cookie;
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [cookieName, ...valueParts] = part.trim().split('=');
    if (cookieName === name) return valueParts.join('=');
  }
  return undefined;
}

function signSession(payloadPart: string, sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update(payloadPart).digest('base64url');
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; p: number; r: number },
): Promise<Buffer> {
  return new Promise((resolveDerived, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolveDerived(Buffer.from(derivedKey));
    });
  });
}

function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly?: boolean; maxAge?: number; path?: string; sameSite?: 'Lax'; secure?: boolean },
): string {
  const parts = [`${name}=${value}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
