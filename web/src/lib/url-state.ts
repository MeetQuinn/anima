// Re-exports from the shared url-routes module.
//
// Navigation is now handled by react-router (useNavigate / useLocation).
// This barrel keeps the re-exported type + utility aliases working so
// import sites don't need to know the backend path.

import { parseAgentFilePath, parseKbPath, parseLocation } from '@shared/url-routes';

export {
  AGENT_TABS,
  DEFAULT_TAB,
  buildPath,
  buildKbPath,
  buildKbRawPath,
  buildAgentFilePath,
  buildAgentFileRawPath,
  parseLocation,
  parseKbPath,
  parseAgentFilePath,
  reconcileLocation,
} from '@shared/url-routes';
export type {
  AgentTab,
  AgentFileLocation,
  ReconcileSnapshot,
  UrlLocation,
  KbLocation,
} from '@shared/url-routes';

/**
 * Stable React key for the layout `<ErrorBoundary>` around `<Outlet>`.
 *
 * The boundary must remount when the *surface* changes so a crashed view
 * cannot trap the app after navigation (web/README.md). It must *not*
 * remount on deep file paths within the same browser: full `pathname` as
 * the key remounted KB / agent Files on every click and reset tree scroll
 * (and forced module-level expanded-dir caches as a workaround).
 *
 * Surfaces:
 * - `/kb/:id/...` → `kb/:id` (file path ignored)
 * - `/agents/:id/files/...` → `agents/:id/files` (file path ignored)
 * - `/agents/:id/:tab` → `agents/:id/:tab`
 * - anything else → full pathname
 */
export function outletErrorBoundaryKey(pathname: string): string {
  const kb = parseKbPath(pathname);
  if (kb) return kb.id ? `kb/${kb.id}` : 'kb';
  const agentFile = parseAgentFilePath(pathname);
  if (agentFile) return `agents/${agentFile.agentId}/files`;
  const agent = parseLocation(pathname);
  if (agent.agentId) {
    return agent.tab ? `agents/${agent.agentId}/${agent.tab}` : `agents/${agent.agentId}`;
  }
  return pathname || '/';
}
