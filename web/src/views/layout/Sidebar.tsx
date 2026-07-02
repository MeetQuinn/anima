import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, FolderTree, MoreHorizontal, Plus, Server } from 'lucide-react';
import {
  DndContext,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { parseLocation } from '@/lib/url-state';
import { fetchAgentStatuses } from '@/api/agents';
import { useLocation, useNavigate } from 'react-router-dom';
import AnimaIcon from '@/components/AnimaIcon';
import ServerPanel from '@/components/ServerPanel';
import { removeKb, renameKb } from '@/api/kb';
import { queryClient } from '@/query-client';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useSidebarOrder } from '@/hooks/useSidebarOrder';
import { useCurrentTeam, useTeams, useTeamWarnings, TEAM_PARAM } from '@/hooks/useTeams';
import type { TeamConfig } from '@/api/teams';
import type { AgentTeamWarning } from '@/api/teams';
import { TeamSwitcher } from './sidebar/TeamSwitcher';
import { CreateTeamModal, EditTeamModal } from './sidebar/TeamModals';
import { useUpdateAvailable } from '@/hooks/useRuntimeUpgrade';
import { agentColor, initialOf } from '@/lib/avatars';
import { agentAvatarUrl, agentDisplayName } from '@/lib/agent-avatar';
import { agentHasConnectedTransport } from '@shared/agent-transports';
import { AgentRow, sidebarDotColor, sidebarDotTitle } from './sidebar/AgentRow';
import { agentOptionId, useSidebarAgentKeyboardNav } from './sidebar/useSidebarAgentKeyboardNav';
import { AgentCreateModal } from '@/views/onboarding';
import {
  AddKbModal,
  ConfirmDeleteModal,
  KebabDropdown,
  RenameKbModal,
} from './sidebar/KbModals';
import type { KbView } from '@shared/kb';
import type { AgentConfig } from '@shared/agent-config';

// Re-exports for MobileNavScreen — no import-path changes needed in consumers.
export { AgentCreateModal } from '@/views/onboarding';
export { AddKbModal } from './sidebar/KbModals';

// ---------------------------------------------------------------------------
// SortableItem — thin wrapper that adds drag affordance to any sidebar row.
// Listeners are applied to the whole wrapper so clicks still propagate to
// children normally (PointerSensor distance:4 constraint allows click-through).
// ---------------------------------------------------------------------------
function SortableItem({
  id,
  children,
  presentation = false,
}: {
  id: string;
  children: React.ReactNode;
  // When the wrapper lives inside an ARIA listbox (the agent list), suppress
  // dnd-kit's accessibility attributes. Those default to role="button" +
  // tabIndex=0 (+ aria-*), which would add a tab stop and insert a focusable
  // wrapper between the listbox and its role="option" rows, breaking the
  // single-tab-stop aria-activedescendant model. We're PointerSensor-only, so
  // these attributes are non-functional anyway (they exist for keyboard drag).
  // setNodeRef/listeners/transform are kept, so pointer reorder is unaffected.
  presentation?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition: transition ?? undefined,
      }}
      {...(presentation ? { role: 'presentation' as const } : attributes)}
      {...listeners}
      className={[
        'group/drag relative select-none',
        isDragging ? 'z-50 opacity-40' : '',
      ].join(' ')}
    >
      {/* No visible drag affordance on desktop: the whole row is draggable via
          the wrapper's pointer listeners, so the grip icon was redundant chrome
          next to the avatar. (Mobile keeps its always-on grip in
          MobileNavScreen, where there's no hover to reveal an affordance.) */}
      {children}
    </div>
  );
}

// Match a KB only on a full path segment, so `/kb/quinn-curriculum` does not
// mark `/kb/quinn` active (a bare `startsWith` prefix-matches sibling ids).
function isKbActive(pathname: string, id: string): boolean {
  const base = `/kb/${id}`;
  return pathname === base || pathname.startsWith(`${base}/`);
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
export default function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { data: statuses = [] } = useQuery({
    queryKey: queryKeys.agentStatuses(),
    queryFn: fetchAgentStatuses,
    refetchInterval: refetchIntervals.agentStatuses,
  });
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { agentId } = parseLocation(pathname);
  const setAgentId = (id: string | null) => navigate(id ? `/agents/${id}` : '/');
  const statusByAgentId = new Map(statuses.map((status) => [status.agentId, status]));
  const runningIds = new Set(
    statuses.filter((s) => s.currentItemId || s.queueDepth > 0).map((s) => s.agentId),
  );

  const teams = useTeams();
  const { currentTeamId, setCurrentTeamId } = useCurrentTeam(teams);
  const {
    orderedAgents,
    orderedKbs,
    agentIndexMap,
    kbIndexMap,
    sensors,
    reorderAgents,
    reorderKbs,
  } = useSidebarOrder(currentTeamId);
  // Repairable team-reference warnings (agent teamId names a team that no longer exists).
  // The agent still degrades into the default team; this only adds a repair cue.
  const teamWarnings = useTeamWarnings();
  const agentNameById = new Map(orderedAgents.map((a) => [a.id, agentDisplayName(a)]));
  // The sidebar shows only the current team, so arrow-key nav follows that flat list.
  const visibleAgentIds = orderedAgents.map((a) => a.id);
  // Arrow up/down to move through agents (selection follows focus, debounced
  // commit). Expanded list only; the collapsed icon rail stays click-only.
  const agentKeyboardNav = useSidebarAgentKeyboardNav({
    agentIds: visibleAgentIds,
    activeAgentId: agentId,
    onCommit: setAgentId,
  });
  // Knowledge Base add modal
  const [showAddModal, setShowAddModal] = useState(false);

  // Agent CRUD state
  const [showAddAgentModal, setShowAddAgentModal] = useState(false);

  // New-team modal (opened from the TeamSwitcher)
  const [showCreateTeamModal, setShowCreateTeamModal] = useState(false);
  // Edit-team modal (opened from a team row's pencil in the TeamSwitcher)
  const [editTeam, setEditTeam] = useState<TeamConfig | null>(null);

  // Kebab menu
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | null>(null);

  // Delete modal
  const [deleteTarget, setDeleteTarget] = useState<KbView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Rename modal
  const [renameTarget, setRenameTarget] = useState<KbView | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  // Server panel
  const [serverPanelOpen, setServerPanelOpen] = useState(false);
  // Resting indicator — a subtle accent dot on the Server trigger when a system
  // update is available. Reuses the panel's query (deduped by key), so no extra
  // request; the dot disappears once the user opens the panel and upgrades.
  const updateAvailable = useUpdateAvailable();

  function openKebab(e: React.MouseEvent<HTMLButtonElement>, id: string) {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuOpenId(id);
    setMenuAnchorRect(rect);
  }

  function closeKebab() {
    setMenuOpenId(null);
    setMenuAnchorRect(null);
  }

  async function executeRemove(id: string) {
    setDeleteBusy(true);
    setDeleteTarget(null);
    try {
      const updated = await removeKb(id);
      queryClient.invalidateQueries({ queryKey: queryKeys.kbs() });
      if (isKbActive(pathname, id)) {
        navigate(updated.length > 0 ? `/kb/${updated[0].id}` : '/');
      }
    } catch {
      // silent — row stays, user can retry
    } finally {
      setDeleteBusy(false);
    }
  }

  async function executeRename(id: string, newLabel: string) {
    setRenameBusy(true);
    setRenameError(null);
    try {
      await renameKb(id, newLabel);
      queryClient.invalidateQueries({ queryKey: queryKeys.kbs() });
      setRenameTarget(null);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Rename failed');
    } finally {
      setRenameBusy(false);
    }
  }

  // One collapsed-rail avatar. Shared by the flat (N=1) and grouped (N>=2) rail
  // renderings so the avatar + status dot stay identical in both.
  const renderCollapsedAgent = (agent: AgentConfig) => {
    const active = agentId === agent.id;
    const isRunning = runningIds.has(agent.id);
    const enabled = agent.enabled !== false;
    const notConnected = enabled && !agentHasConnectedTransport(agent);
    const color = agentColor(agentIndexMap.get(agent.id) ?? 0);
    const displayName = agentDisplayName(agent);
    const avatarUrl = agentAvatarUrl(agent);
    const initial = initialOf(displayName);
    const collapsedStatus = statusByAgentId.get(agent.id);
    const showCollapsedDot = enabled && !notConnected;
    return (
      <div key={agent.id} className="relative w-full flex justify-center">
        {active && (
          <span aria-hidden className="absolute left-0 top-2 bottom-2 w-0.5 bg-accent" />
        )}
        <button
          onClick={() => setAgentId(agent.id)}
          title={displayName}
          className={[
            'flex h-11 w-11 items-center justify-center rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            active ? 'bg-spine-elevated' : 'hover:bg-spine-elevated/30',
          ].join(' ')}
        >
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className={[
                'h-9 w-9 rounded-lg object-cover ring-1 ring-avatar-ring-spine',
                !enabled || notConnected ? 'opacity-40 grayscale' : '',
              ].join(' ')}
            />
          ) : (
            <span
              className={[
                'font-sans flex h-9 w-9 items-center justify-center rounded-lg text-[13px] font-bold text-white ring-1 ring-avatar-ring-spine',
                !enabled || notConnected ? 'opacity-40' : '',
              ].join(' ')}
              style={{ background: color }}
            >
              {initial}
            </span>
          )}
          {/* Status dot — color encodes all health states, same mapping as the
              expanded AgentRow dot. Always shown for enabled + connected agents so
              a red unhealthy/provider-failure agent is never invisible. */}
          {showCollapsedDot && (
            <span
              aria-hidden
              className="absolute right-0.5 bottom-0.5 h-2 w-2 shrink-0 rounded-full border border-page"
              title={sidebarDotTitle(collapsedStatus?.health, isRunning)}
              style={{ background: sidebarDotColor(collapsedStatus?.health, isRunning) }}
            />
          )}
        </button>
      </div>
    );
  };

  // One expanded-sidebar agent row. Shared by the flat (N=1) and grouped (N>=2)
  // renderings so the row markup stays identical in both.
  const renderAgentRow = (agent: AgentConfig) => {
    const status = statusByAgentId.get(agent.id);
    return (
      <SortableItem key={agent.id} id={agent.id} presentation>
        <AgentRow
          agent={agent}
          index={agentIndexMap.get(agent.id) ?? 0}
          active={agentId === agent.id}
          isRunning={runningIds.has(agent.id)}
          enabled={agent.enabled !== false}
          {...(status ? { status } : {})}
          onClick={() => setAgentId(agent.id)}
          optionId={agentOptionId(agent.id)}
          focused={agentKeyboardNav.isOptionFocused(agent.id)}
        />
      </SortableItem>
    );
  };

  // A small, repairable warning cue for agents whose teamId no longer resolves. Not a global
  // banner: it renders inline where the agent was folded (its effective team group, or the
  // flat list at N=1), names the dangling id, and points at the fix.
  const renderTeamWarnings = (scoped: AgentTeamWarning[]) => {
    if (scoped.length === 0) return null;
    return (
      <div className="mt-1 space-y-1">
        {scoped.map((w) => (
          <div
            key={w.agentId}
            className="flex items-start gap-1.5 rounded-sm bg-health-warn/10 px-2 py-1"
            role="status"
          >
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-health-warn" />
            <span className="font-serif text-[11px] leading-snug text-text-on-spine-muted">
              <span className="font-semibold text-text-on-spine">
                {agentNameById.get(w.agentId) ?? w.agentId}
              </span>{' '}
              references team <span className="font-mono">"{w.teamId}"</span>, which no longer
              exists. Reassign it to repair.
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <aside
        className={[
          'relative hidden md:flex h-dvh shrink-0 flex-col overflow-hidden border-r border-spine-border bg-page',
          'transition-[width] duration-200 ease-out',
          collapsed ? 'w-[68px]' : 'w-64',
        ].join(' ')}
      >

        {/* ── COLLAPSED RAIL ──────────────────────────────────────────────── */}
        <div
          aria-hidden={!collapsed}
          className={[
            'absolute inset-0 flex flex-col transition-opacity duration-150 ease-out',
            collapsed ? 'opacity-100' : 'opacity-0 pointer-events-none',
          ].join(' ')}
        >
          {/* Header — Anima icon is the expand button */}
          <button
            onClick={onToggle}
            title="Expand sidebar"
            className="flex h-14 shrink-0 w-full items-center justify-center border-b border-spine-border hover:bg-spine-elevated/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent transition-colors"
          >
            <AnimaIcon className="h-4 w-4 text-accent" />
          </button>

          {/* Scrollable nav items */}
          <div className="flex flex-1 flex-col items-center overflow-y-auto py-2 gap-2">
            {/* KB — colored initial blocks (ordered) */}
            {orderedKbs.map((kb) => {
              const active = isKbActive(pathname, kb.id);
              const color = agentColor((kbIndexMap.get(kb.id) ?? 0) + 6);
              const initial = initialOf(kb.label);
              return (
                <div key={kb.id} className="relative w-full flex justify-center">
                  {active && (
                    <span aria-hidden className="absolute left-0 top-2 bottom-2 w-0.5 bg-accent" />
                  )}
                  <button
                    onClick={() => navigate(`/kb/${kb.id}`)}
                    title={kb.label}
                    className={[
                      'flex h-11 w-11 items-center justify-center rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      active ? 'bg-spine-elevated' : 'hover:bg-spine-elevated/30',
                    ].join(' ')}
                  >
                    <span
                      className="font-sans flex h-9 w-9 items-center justify-center rounded-lg text-[13px] font-bold text-white ring-1 ring-avatar-ring-spine"
                      style={{ background: color }}
                    >
                      {initial}
                    </span>
                  </button>
                </div>
              );
            })}

            {/* Divider between KB and agents when both present */}
            {orderedKbs.length > 0 && orderedAgents.length > 0 && (
              <div className="w-full shrink-0 border-t border-spine-border my-1" />
            )}

            {/* Agent avatars with status dots — the current team's agents, flat. */}
            {orderedAgents.map(renderCollapsedAgent)}
          </div>

          {/* Footer — server only */}
          <div className="shrink-0 border-t border-spine-border py-1.5 flex justify-center">
            <button
              data-server-panel-trigger
              onClick={() => setServerPanelOpen((v) => !v)}
              title={updateAvailable ? 'Server — update available' : 'Server status & restart'}
              className="relative flex h-8 w-8 items-center justify-center rounded-sm text-text-on-spine-muted hover:bg-spine-elevated hover:text-text-on-spine focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <Server className="h-3.5 w-3.5" />
              {updateAvailable && (
                <span
                  aria-hidden
                  className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent ring-1 ring-spine-border"
                />
              )}
            </button>
          </div>
        </div>

        {/* Collapse chevron — floats over the expanded content */}
        {!collapsed && (
          <button
            onClick={onToggle}
            className="absolute right-3 top-3.5 z-10 flex h-6 w-6 items-center justify-center rounded-sm text-text-on-spine-muted hover:bg-spine-elevated hover:text-text-on-spine focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            title="Collapse sidebar"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}

        {/* ── EXPANDED CONTENT ────────────────────────────────────────────── */}
        <div
          aria-hidden={collapsed}
          className={[
            'flex h-full w-64 shrink-0 flex-col transition-opacity duration-150 ease-out',
            collapsed ? 'pointer-events-none opacity-0' : 'opacity-100',
          ].join(' ')}
        >
          <TeamSwitcher
            teams={teams}
            currentTeamId={currentTeamId}
            onSelectTeam={(id) => {
              if (id === currentTeamId) return;
              setCurrentTeamId(id);
              // Clear the main panel so it follows the new team: drop the open
              // agent (or KB) back to `/` while KEEPING ?team= in the same hop
              // (matching the fresh-load shape). AgentReconciler then lands on the
              // new team's first agent, or stays blank if the team is empty.
              // Preserving the param here avoids a drop + re-sync race with the
              // reconciler that would otherwise strand the URL at `/`.
              navigate(`/?${TEAM_PARAM}=${encodeURIComponent(id)}`);
            }}
            onNewTeam={() => setShowCreateTeamModal(true)}
            onEditTeam={(team) => setEditTeam(team)}
          />

          <div className="flex-1 overflow-y-auto p-3">
            {/* Knowledge Base section */}
            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between pl-3">
                <div className="flex items-center gap-1.5">
                  <span className="caps text-text-on-spine-subtle">Knowledge Base</span>
                  <span className="font-mono text-[10px] text-text-on-spine-subtle">
                    {orderedKbs.length}
                  </span>
                </div>
                <button
                  onClick={() => setShowAddModal(true)}
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-text-on-spine-muted hover:bg-spine-elevated hover:text-text-on-spine focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  title="Add Knowledge Base"
                  aria-label="Add Knowledge Base"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>

              <div className="space-y-0.5">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={reorderKbs}
                >
                  <SortableContext
                    items={orderedKbs.map((kb) => kb.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {orderedKbs.map((kb) => {
                      const active = isKbActive(pathname, kb.id);
                      return (
                        <SortableItem key={kb.id} id={kb.id}>
                          <div
                            className={[
                              'group relative flex min-h-[44px] w-full items-center rounded-sm transition-colors',
                              active ? 'bg-spine-elevated' : 'hover:bg-spine-elevated/60',
                            ].join(' ')}
                          >
                            {active && (
                              <span
                                aria-hidden
                                className="absolute left-0 top-1.5 bottom-1.5 w-px bg-accent"
                              />
                            )}
                            <button
                              onClick={() => navigate(`/kb/${kb.id}`)}
                              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset"
                            >
                              <FolderTree className="h-4 w-4 shrink-0 text-text-on-spine-muted" />
                              <span
                                className={[
                                  'truncate font-serif text-[14px] leading-tight text-text-on-spine',
                                  active ? 'font-semibold' : 'font-medium',
                                ].join(' ')}
                              >
                                {kb.label}
                              </span>
                            </button>
                            <button
                              onClick={(e) => openKebab(e, kb.id)}
                              className="mr-1 flex min-h-[44px] w-8 shrink-0 items-center justify-center rounded-sm text-text-on-spine-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-spine-elevated hover:text-text-on-spine focus-visible:outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent"
                              title="Knowledge Base options"
                              aria-label="Knowledge Base options"
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </SortableItem>
                      );
                    })}
                  </SortableContext>
                </DndContext>

                {orderedKbs.length === 0 && (
                  <button
                    onClick={() => setShowAddModal(true)}
                    className="flex items-center gap-1.5 px-2 font-sans text-[11px] text-text-on-spine-subtle hover:text-text-on-spine"
                  >
                    <Plus className="h-3 w-3" />
                    Add Knowledge Base
                  </button>
                )}
              </div>
            </div>

            {/* Agents section */}
            <div className="mb-3 flex items-center justify-between pl-3">
              <div className="flex items-center gap-1.5">
                <span className="caps text-text-on-spine-subtle">Agents</span>
                <span className="font-mono text-[10px] text-text-on-spine-subtle">
                  {orderedAgents.length}
                </span>
              </div>
              <button
                onClick={() => setShowAddAgentModal(true)}
                className="flex h-7 w-7 items-center justify-center rounded-sm text-text-on-spine-muted hover:bg-spine-elevated hover:text-text-on-spine focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                title="Add agent"
                aria-label="Add agent"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
            <div
              className="rounded-sm focus-visible:outline-none"
              aria-label="Agents"
              {...agentKeyboardNav.listboxProps}
            >
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={reorderAgents}
              >
                {/* Flat list of the current team's agents. Switching teams in the
                    TeamSwitcher swaps which team's agents (and KBs) are shown. */}
                <div className="space-y-0.5">
                  <SortableContext
                    items={orderedAgents.map((a) => a.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {orderedAgents.map(renderAgentRow)}
                  </SortableContext>
                  {orderedAgents.length === 0 && (
                    <button
                      onClick={() => setShowAddAgentModal(true)}
                      className="flex items-center gap-1.5 px-2 font-sans text-[11px] text-text-on-spine-subtle hover:text-text-on-spine"
                    >
                      <Plus className="h-3 w-3" />
                      Add agent
                    </button>
                  )}
                  {renderTeamWarnings(
                    teamWarnings.filter((w) => w.effectiveTeamId === currentTeamId),
                  )}
                </div>
              </DndContext>
            </div>
          </div>

          <div className="border-t border-spine-border p-2">
            <button
              data-server-panel-trigger
              onClick={() => setServerPanelOpen((v) => !v)}
              className="chrome flex w-full cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2.5 text-left text-[11px] uppercase tracking-[0.1em] text-text-on-spine-muted transition-colors hover:bg-spine-elevated hover:text-text-on-spine focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              title="Server status &amp; restart"
            >
              <Server className="h-3.5 w-3.5" />
              <span>Server</span>
              {updateAvailable && (
                <span
                  aria-hidden
                  className="ml-auto h-1.5 w-1.5 rounded-full bg-accent"
                  title="Update available"
                />
              )}
            </button>
          </div>
        </div>
      </aside>

      {/* Portals — rendered outside aside so they're never clipped by overflow:hidden */}

      {showAddModal && (
        <AddKbModal
          teamId={currentTeamId}
          onClose={() => setShowAddModal(false)}
          onAdded={(newId) => {
            queryClient.invalidateQueries({ queryKey: queryKeys.kbs() });
            navigate(`/kb/${newId}`);
          }}
        />
      )}

      {menuOpenId !== null && menuAnchorRect !== null && (
        <KebabDropdown
          anchorRect={menuAnchorRect}
          onRename={() => {
            const kb = orderedKbs.find((r) => r.id === menuOpenId);
            closeKebab();
            if (kb) setRenameTarget(kb);
          }}
          onDelete={() => {
            const kb = orderedKbs.find((r) => r.id === menuOpenId);
            closeKebab();
            if (kb) setDeleteTarget(kb);
          }}
          onClose={closeKebab}
        />
      )}

      {renameTarget !== null && (
        <RenameKbModal
          kb={renameTarget}
          busy={renameBusy}
          error={renameError}
          onConfirm={(newLabel) => void executeRename(renameTarget.id, newLabel)}
          onCancel={() => {
            setRenameTarget(null);
            setRenameError(null);
          }}
        />
      )}

      {deleteTarget !== null && (
        <ConfirmDeleteModal
          kb={deleteTarget}
          busy={deleteBusy}
          onConfirm={() => void executeRemove(deleteTarget.id)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {showAddAgentModal && (
        <AgentCreateModal
          onClose={() => setShowAddAgentModal(false)}
          teams={teams}
          defaultTeamId={currentTeamId}
        />
      )}

      {showCreateTeamModal && (
        <CreateTeamModal
          onClose={() => setShowCreateTeamModal(false)}
          onCreated={(team) => setCurrentTeamId(team.id)}
        />
      )}

      {editTeam && (
        <EditTeamModal
          team={editTeam}
          onClose={() => setEditTeam(null)}
          // Editing is navigation-neutral: it never switches the working team (renaming the
          // team you're on refreshes its label via query invalidation; editing another team
          // does not yank you into it). Just close.
          onSaved={() => setEditTeam(null)}
        />
      )}

      {serverPanelOpen && <ServerPanel onClose={() => setServerPanelOpen(false)} />}
    </>
  );
}
