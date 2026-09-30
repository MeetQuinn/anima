import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { applyRuntimeUpgrade, checkRuntimeUpgrade, restartServices } from './system';

afterEach(() => vi.unstubAllGlobals());

it('upgrade and restart requests survive chunked transport with a JSON body', async () => {
  const app = Fastify();
  const calls: string[] = [];
  for (const path of ['/api/system-update/check', '/api/system-update/apply', '/api/services/restart']) {
    app.post(path, (request) => {
      calls.push(path);
      expect(request.body).toEqual({});
      return { ok: true };
    });
  }
  try {
    // The failure shape from the phone report: a bodyless POST becomes
    // chunked in transit and is rejected before reaching its handler.
    const control = await app.inject({
      method: 'POST', url: '/api/system-update/apply',
      headers: { 'transfer-encoding': 'chunked' },
    });
    expect(control.statusCode).toBe(415);
    expect(calls).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const response = await app.inject({
        method: 'POST', url,
        headers: { ...Object.fromEntries(new Headers(init.headers).entries()), 'transfer-encoding': 'chunked' },
        payload: init.body as string,
      });
      return new Response(response.body, { status: response.statusCode });
    }));
    await checkRuntimeUpgrade();
    await applyRuntimeUpgrade();
    await restartServices();
    expect(calls).toEqual(['/api/system-update/check', '/api/system-update/apply', '/api/services/restart']);
  } finally {
    await app.close();
  }
});
