// Client-error reporting — local only.
//
// Uncaught front-end errors are POSTed to the operator's OWN Anima backend
// (`/api/client-errors`), which appends them to a local log. This is NOT
// telemetry: nothing is sent to us or any third party, and there is no outbound
// path. Reports stay in the user's own runtime/infrastructure and never reach
// us. (Over a LAN dashboard the browser and host can be different machines, so
// it is not "never leaves this computer" — but it never leaves the user's
// infrastructure.)
//
// Reporting is strictly best-effort: it never throws, never blocks, and never
// recurses (a failed POST is swallowed silently rather than re-reported).

export type ClientErrorKind = 'error' | 'unhandledrejection' | 'render';

export interface ClientErrorInput {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  componentStack?: string;
}

// Client-side storage caps (the server truncates again as defence in depth).
const MAX_MESSAGE = 4_000;
const MAX_STACK = 20_000;

// Dedupe identical errors within a short window so a repeating error doesn't
// spam the log on every render/tick.
const DEDUPE_WINDOW_MS = 15_000;
// Burst cap: at most this many reports per rolling window, so a render loop
// can't flood the endpoint.
const BURST_WINDOW_MS = 60_000;
const BURST_MAX = 25;

const lastSentBySignature = new Map<string, number>();
let burstWindowStart = 0;
let burstCount = 0;

function now(): number {
  return Date.now();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

function shouldSend(signature: string): boolean {
  const ts = now();

  const last = lastSentBySignature.get(signature);
  if (last !== undefined && ts - last < DEDUPE_WINDOW_MS) return false;

  if (ts - burstWindowStart > BURST_WINDOW_MS) {
    burstWindowStart = ts;
    burstCount = 0;
  }
  if (burstCount >= BURST_MAX) return false;

  burstCount += 1;
  lastSentBySignature.set(signature, ts);

  // Keep the dedupe map from growing unbounded under churning signatures.
  if (lastSentBySignature.size > 200) {
    for (const [key, when] of lastSentBySignature) {
      if (ts - when > DEDUPE_WINDOW_MS) lastSentBySignature.delete(key);
    }
  }

  return true;
}

export function reportClientError(input: ClientErrorInput): void {
  try {
    const message = truncate(input.message || 'Unknown error', MAX_MESSAGE);
    const stack = input.stack ? truncate(input.stack, MAX_STACK) : undefined;
    const componentStack = input.componentStack
      ? truncate(input.componentStack, MAX_STACK)
      : undefined;

    const signature = `${input.kind}|${message}|${stack ?? ''}`;
    if (!shouldSend(signature)) return;

    const payload = {
      kind: input.kind,
      message,
      ...(stack ? { stack } : {}),
      ...(componentStack ? { componentStack } : {}),
      // pathname only — never include origin, query string, or hash (a query
      // param can carry a token or other sensitive state).
      path: window.location.pathname,
      userAgent: navigator.userAgent,
      createdAt: new Date().toISOString(),
    };

    // Fire-and-forget. keepalive lets it survive a navigation/unload. Any
    // failure is swallowed — reporting must never surface or re-report.
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Reporting must never break the app.
  }
}

let installed = false;

export function installGlobalErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    // Resource-load errors (img/script) don't bubble to window with the default
    // (non-capture) listener, so anything here is an uncaught script error.
    reportClientError({
      kind: 'error',
      message: event.message || (event.error instanceof Error ? event.error.message : 'Unknown error'),
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    reportClientError({
      kind: 'unhandledrejection',
      message:
        reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
