// Pure URL ↔ state helpers for the web app.
//
// Shared between the frontend (Vite, via @shared/url-routes) and the backend
// test suite (NodeNext, via ../shared/url-routes.js). No server-only imports.

import { agentHasConnectedTransport } from './agent-transports.js';

export type AgentTab = 'activity' | 'channels' | 'profile' | 'reminders';

export const AGENT_TABS: readonly AgentTab[] = ['activity', 'channels', 'profile', 'reminders'] as const;
export const DEFAULT_TAB: AgentTab = 'activity';

export interface UrlLocation {
  agentId: string | null;
  tab: AgentTab | null;
}

/**
 * Parse `/`, `/agents/<id>`, `/agents/<id>/<tab>` into URL state.
 * - Bare `/` → both null.
 * - `/agents/<id>` → tab null (AgentBootstrap will replaceState to `activity`).
 * - Unknown tab → null (validation layer will normalize).
 * - Anything else (trailing slashes, extra segments) → null/null (treated as `/`).
 */
export function parseLocation(pathname: string): UrlLocation {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return { agentId: null, tab: null };
  if (segments[0] !== 'agents') return { agentId: null, tab: null };
  const agentId = segments[1];
  if (!agentId) return { agentId: null, tab: null };
  if (segments.length === 2) return { agentId, tab: null };
  if (segments.length === 3) {
    const candidate = segments[2];
    if (candidate && (AGENT_TABS as readonly string[]).includes(candidate)) {
      return { agentId, tab: candidate as AgentTab };
    }
    return { agentId, tab: null };
  }
  // 4+ segments → unknown shape, treat as bare root.
  return { agentId: null, tab: null };
}

export function buildPath(loc: { agentId: string | null; tab: AgentTab | null }): string {
  if (!loc.agentId) return '/';
  if (!loc.tab) return `/agents/${loc.agentId}`;
  return `/agents/${loc.agentId}/${loc.tab}`;
}

// --- Kb surface ------------------------------------------------------
//
// A top-level (non-agent) browse surface over a team-kb git tree. URLs:
//   /kb                       → root picker (no root selected)
//   /kb/<id>              → a kb's tree, no file open
//   /kb/<id>/<file/path>  → a specific tracked file, deep-linkable
//
// `/kb/raw/...` is the backend raw-bytes route (iframe/img src targets),
// never an SPA browse target — it is matched server-side before the static
// fallback. We treat it as "not a browse path" defensively here too.

const KB_PREFIX = 'kb';

export interface KbLocation {
  id: string | null;
  filePath: string | null; // repo-relative POSIX, or null when only a kb is selected
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Parse a kb browse path into `{ id, filePath }`, or `null` for any
 * non-kb path (so the caller falls back to agent routing).
 */
export function parseKbPath(pathname: string): KbLocation | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== KB_PREFIX) return null;
  const id = segments[1];
  if (!id) return { id: null, filePath: null };
  if (id === 'raw') return null; // backend raw route, not a browse target
  const decoded = safeDecode(id);
  if (segments.length === 2) return { id: decoded, filePath: null };
  const filePath = segments.slice(2).map(safeDecode).join('/');
  return { id: decoded, filePath: filePath || null };
}

export function buildKbPath(loc: KbLocation): string {
  if (!loc.id) return `/${KB_PREFIX}`;
  const encoded = encodeURIComponent(loc.id);
  if (!loc.filePath) return `/${KB_PREFIX}/${encoded}`;
  const file = loc.filePath.split('/').map(encodeURIComponent).join('/');
  return `/${KB_PREFIX}/${encoded}/${file}`;
}

/**
 * Build the backend raw-bytes URL for a tracked file (iframe / img / asset
 * target). Per-segment encoding keeps `/` literal as path separators, matching
 * the server's decode of the `<id>/<filePath>` tail.
 */
export function buildKbRawPath(id: string, filePath: string): string {
  const encoded = encodeURIComponent(id);
  const file = filePath.split('/').map(encodeURIComponent).join('/');
  return `/${KB_PREFIX}/raw/${encoded}/${file}`;
}

/**
 * Inputs `reconcileLocation` needs from the current web state. We accept a
 * minimal shape so the function is trivially testable without constructing the
 * full route context.
 */
export interface ReconcileSnapshot {
  // transport connected flags are derived server-side from real credential
  // presence. Tokens/secrets are always redacted to "" on the wire, so checking
  // raw token fields is unreliable.
  agents: ReadonlyArray<{
    feishu?: { connected?: boolean };
    id: string;
    slack?: { connected?: boolean };
  }>;
  agentStatuses: ReadonlyArray<{ agentId: string; currentItemId?: string; queueDepth: number }>;
  selectedAgentId?: string;
}

/**
 * Decide whether the current URL state needs a replaceState canonicalization.
 * Returns the desired target, or `null` when no change is needed.
 *
 *   - Unknown agentId              → reset to `/` (next pass re-picks).
 *   - No agentId in URL            → pick most-recently-active / selected / first.
 *   - Valid agentId, no tab        → fill in DEFAULT_TAB (or 'profile' if not-connected).
 *   - Otherwise                    → no-op.
 *
 * Sidebar/mobile-nav clicks navigate to `/agents/:id` (no tab), so this
 * function handles the default-tab selection. Explicit tab clicks from the
 * header nav set a specific tab and are NOT overridden here — a not-connected
 * agent can visit Activity and see the empty state.
 */
export function reconcileLocation(
  snapshot: ReconcileSnapshot,
  current: UrlLocation,
): UrlLocation | null {
  const knownIds = new Set(snapshot.agents.map((a) => a.id));

  if (current.agentId && !knownIds.has(current.agentId)) {
    // Unknown agent — don't silently redirect to another agent; let the view
    // render its own not-found state once the data confirms the ID is invalid.
    return null;
  }

  if (!current.agentId) {
    const active = snapshot.agentStatuses.find((s) => s.currentItemId || s.queueDepth > 0);
    const pick = active?.agentId ?? snapshot.selectedAgentId ?? snapshot.agents[0]?.id ?? null;
    if (pick && knownIds.has(pick)) {
      const pickedAgent = snapshot.agents.find((a) => a.id === pick);
      const tab = pickedAgent && agentHasConnectedTransport(pickedAgent) ? DEFAULT_TAB : 'profile';
      return { agentId: pick, tab };
    }
    return null;
  }

  // Valid agentId from here.
  const agent = snapshot.agents.find((a) => a.id === current.agentId);
  const notConnected = !!agent && !agentHasConnectedTransport(agent);

  // Not-connected agents with no tab: default to Profile so the connection
  // surface is immediately visible. Explicit tab choices (activity, reminders)
  // are honoured — the sidebar always navigates to /agents/:id (no tab), so
  // this branch fires on every sidebar click without catching in-page tab
  // switches.
  if (notConnected && current.tab === null) {
    return { agentId: current.agentId, tab: 'profile' };
  }

  if (current.tab === null) {
    return { agentId: current.agentId, tab: DEFAULT_TAB };
  }

  return null;
}
