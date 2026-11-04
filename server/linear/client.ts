import { z } from 'zod';

// Only these standard OAuth codes are read from a token error; the
// description is never kept, logged or shown.
const OAuthErrorCode = z.enum(['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']);
export type LinearOAuthError = z.infer<typeof OAuthErrorCode>;

export class LinearApiError extends Error {
  constructor(message: string, readonly revoked = false, readonly status?: number, readonly failure?: 'network' | 'http' | 'response', readonly oauthError?: LinearOAuthError) { super(message); }
}
const GrantedScopes = z.union([z.string().transform((value) => value.split(/\s+/).filter(Boolean)), z.array(z.string())]);
const Tokens = z.object({ scope: GrantedScopes.optional(), access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive() });
type LinearTokens = z.infer<typeof Tokens>;
export class LinearClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async uploadFile(url: string, signedHeaders: { key: string; value: string }[], file: Blob): Promise<void> {
    // The signed URL authenticates this request. Never forward the OAuth token,
    // follow a redirect, or expose storage response bodies / fetch error causes.
    try {
      const headers = new Headers({ 'content-type': file.type, 'cache-control': 'public, max-age=31536000' });
      for (const { key, value } of signedHeaders) headers.set(key, value);
      const response = await this.fetcher(url, { method: 'PUT', headers, body: file, redirect: 'error', signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error('Upload rejected');
    } catch { throw new Error('Linear file upload failed. No reply was posted; some files may already have uploaded.'); }
  }

  async token(form: Record<string, string>): Promise<LinearTokens> {
    let response: Response;
    try {
      response = await this.fetcher('https://api.linear.app/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form), signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
    } catch { throw new LinearApiError('Linear token request failed; retry installation or inspect the connection.', false, undefined, 'network'); }
    if (!response.ok) {
      // A token rejection is HTTP 400, or 401 for client authentication (RFC 6749
      // section 5.2). Only then is its error code read; 5xx and any other status
      // keep the installation and tokens whatever the body says.
      const rejection = response.status === 400 || response.status === 401;
      const parsed = rejection ? OAuthErrorCode.safeParse(((await response.json().catch(() => undefined)) as { error?: unknown } | undefined)?.error) : undefined;
      const oauthError = parsed?.success ? parsed.data : undefined;
      // Of those, only an explicit invalid_grant means the grant is gone.
      throw new LinearApiError('Linear token request was rejected.', oauthError === 'invalid_grant', response.status, 'http', oauthError);
    }
    try { return Tokens.parse(await response.json()); }
    catch { throw new LinearApiError('Linear returned an invalid token response.', false, undefined, 'response'); }
  }

  async graphql<T>(token: string, query: string, variables: Record<string, unknown>, schema: z.ZodType<T>, operationName?: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher('https://api.linear.app/graphql', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables, ...(operationName ? { operationName } : {}) }), signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
    } catch { throw new LinearApiError('Linear request failed. If this request included a write, inspect its result before retrying; it may have succeeded.', false, undefined, 'network'); }
    if (response.status === 401) throw new LinearApiError('Linear request was unauthorized.', true, 401, 'http');
    if (!response.ok) throw new LinearApiError('Linear request failed.', false, response.status, 'http');
    try {
      const body = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() }).parse(await response.json());
      if (body.errors?.length) throw new Error('GraphQL error');
      return schema.parse(body.data);
    } catch { throw new LinearApiError('Linear returned an invalid or rejected result.', false, undefined, 'response'); }
  }
}
