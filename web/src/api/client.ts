// ---------------------------------------------------------------------------
// Core HTTP client shared by all API modules.
// ---------------------------------------------------------------------------

export async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    if (res.status === 401) redirectToLogin(url);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// Only sets Content-Type: application/json when a body is present —
// sending the header on bodyless POSTs causes Fastify to reject them.
export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }
      : {}),
  };
}

function redirectToLogin(url: string): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === '/login') return;
  if (url.startsWith('/api/auth/')) return;
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(`/login?next=${encodeURIComponent(next || '/')}`);
}
