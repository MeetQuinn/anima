import { useState } from 'react';
import { useRouteError } from 'react-router-dom';
import { AlertCircle, RefreshCw } from 'lucide-react';

// Session-storage key: stores the timestamp of the last auto-reload triggered
// by a chunk load failure. Used to break reload loops — if we reloaded within
// the last 10 seconds and still see a chunk error, show the error UI instead
// of reloading again. Stale entries (>10 s) are ignored, so subsequent
// upgrades within the same browser session still get the auto-reload.
const CHUNK_RELOAD_TS_KEY = 'anima_chunk_reload_ts';
const CHUNK_RELOAD_DEBOUNCE_MS = 10_000;

/**
 * Returns true for TypeError thrown by Vite/browsers when a dynamically
 * imported module cannot be fetched (i.e. the chunk was removed after a
 * runtime upgrade).
 */
function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const msg = error.message;
  return (
    msg.includes('dynamically imported module') ||
    msg.includes('Importing a module script failed') ||
    msg.includes('Loading chunk') ||
    // Safari/Firefox phrase for failed dynamic import fetch
    msg.includes('error loading dynamically imported module')
  );
}

/**
 * Route-level error boundary for React Router v6.
 *
 * When a lazy-loaded route chunk fails to fetch (stale asset after a runtime
 * upgrade), this triggers a transparent full-page reload so the user gets the
 * fresh build rather than seeing an error screen. A timestamp guard prevents
 * infinite reload loops: if a reload was already attempted within the last 10 s
 * and the error persists, the generic error UI is shown instead.
 *
 * Add as `errorElement` on the top-level routes in router.tsx.
 */
export default function RouteErrorBoundary() {
  const error = useRouteError();
  // Capture the current timestamp once when this boundary first renders.
  // useState's lazy initializer runs synchronously once and is stable —
  // React treats it as pure, unlike a bare Date.now() call in render.
  const [now] = useState(() => Date.now());

  if (isChunkLoadError(error)) {
    const lastTs = sessionStorage.getItem(CHUNK_RELOAD_TS_KEY);
    const recentlyReloaded =
      lastTs !== null && now - parseInt(lastTs, 10) < CHUNK_RELOAD_DEBOUNCE_MS;

    if (!recentlyReloaded) {
      sessionStorage.setItem(CHUNK_RELOAD_TS_KEY, String(now));
      window.location.reload();
      // Return null — the reload is in flight; this render is a no-op.
      return null;
    }
    // Fell through: reloaded recently and still hitting a chunk error.
    // Fall through to the generic error UI to avoid a reload loop.
  }

  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertCircle className="h-8 w-8 text-health-error" aria-hidden />
      <div>
        <div className="font-serif text-[16px] font-semibold text-text">
          Something went wrong
        </div>
        <div className="mt-1 font-mono text-[12px] text-text-muted">{message}</div>
      </div>
      <button
        onClick={() => {
          sessionStorage.removeItem(CHUNK_RELOAD_TS_KEY);
          window.location.reload();
        }}
        className="flex items-center gap-1.5 rounded-sm border border-border-soft bg-surface px-4 py-2 font-sans text-[13px] text-text hover:bg-surface-elevated"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden />
        Reload
      </button>
    </div>
  );
}
