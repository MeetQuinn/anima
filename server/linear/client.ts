import { z } from 'zod';

export class LinearApiError extends Error {
  constructor(message: string, readonly revoked = false) { super(message); }
}
const Tokens = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive() });
type LinearTokens = z.infer<typeof Tokens>;
export class LinearClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async token(form: Record<string, string>): Promise<LinearTokens> {
    let response: Response;
    try {
      response = await this.fetcher('https://api.linear.app/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form), signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
    } catch { throw new LinearApiError('Linear token request failed; retry installation or inspect the connection.'); }
    if (!response.ok) throw new LinearApiError('Linear token request was rejected.', response.status === 400 || response.status === 401);
    try { return Tokens.parse(await response.json()); }
    catch { throw new LinearApiError('Linear returned an invalid token response.'); }
  }

  async graphql<T>(token: string, query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const mutation = query.trimStart().startsWith('mutation');
    let response: Response;
    try {
      response = await this.fetcher('https://api.linear.app/graphql', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
    } catch { throw new LinearApiError(mutation ? 'Linear result is unknown; inspect the session before retrying.' : 'Linear read failed.'); }
    if (response.status === 401) throw new LinearApiError('Linear authorization was revoked.', true);
    if (!response.ok) throw new LinearApiError('Linear request failed.');
    try {
      const body = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() }).parse(await response.json());
      if (body.errors?.length) throw new Error('GraphQL error');
      return schema.parse(body.data);
    } catch { throw new LinearApiError('Linear returned an invalid or rejected result.'); }
  }
}
