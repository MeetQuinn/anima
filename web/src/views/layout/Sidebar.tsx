import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, FolderTree, GripVertical, MoreHorizontal, Plus, Server } from 'lucide-react';
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
import { useUpdateAvailable } from '@/hooks/useRuntimeUpgrade';
import { agentColor, initialOf } from '@/lib/avatars';
import { AgentRow } from './sidebar/AgentRow';
import { AgentCreateModal } from '@/views/onboarding';
import {
  AddKbModal,
  ConfirmDeleteModal,
  KebabDropdown,
  RenameKbModal,
} from './sidebar/KbModals';
import type { KbView } from '@shared/kb';

// Re-exports for MobileNavScreen — no import-path changes needed in consumers.
export { AgentCreateModal } from '@/views/onboarding';
export { AddKbModal } from './sidebar/KbModals';

// ---------------------------------------------------------------------------
// SortableItem — thin wrapper that adds drag affordance to any sidebar row.
// Listeners are applied to the whole wrapper so clicks still propagate to
// children normally (PointerSensor distance:4 constraint allows click-through).
// ---------------------------------------------------------------------------
function SortableItem({ id, children }: { id: string; children: React.ReactNode }) {
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
      {...attributes}
      {...listeners}
      className={[
        'group/drag relative select-none',
        isDragging ? 'z-50 opacity-40' : '',
      ].join(' ')}
    >
      {/* Drag affordance — visual hint only, pointer-events-none */}
      <GripVertical
        aria-hidden
        className="pointer-events-none absolute left-0.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-on-spine-subtle opacity-0 transition-opacity group-hover/drag:opacity-50"
      />
      {children}
    </div>
  );
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
  const runningIds = new Set(
    statuses.filter((s) => s.currentItemId || s.queueDepth > 0).map((s) => s.agentId),
  );

  const { orderedAgents, orderedKbs, agentIndexMap, kbIndexMap, sensors, reorderAgents, reorderKbs } = useSidebarOrder();

  // Knowledge Base add modal
  const [showAddModal, setShowAddModal] = useState(false);

  // Agent CRUD state
  const [showAddAgentModal, setShowAddAgentModal] = useState(false);

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
      if (pathname.startsWith(`/kb/${id}`)) {
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
              const active = pathname.startsWith(`/kb/${kb.id}`);
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
                      className="font-sans flex h-9 w-9 items-center justify-center rounded-sm text-[13px] font-bold text-white"
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

            {/* Agent avatars with status dots (ordered) */}
            {orderedAgents.map((agent) => {
              const active = agentId === agent.id;
              const isRunning = runningIds.has(agent.id);
              const enabled = agent.enabled !== false;
              const notConnected = enabled && agent.slack?.connected !== true;
              const color = agentColor(agentIndexMap.get(agent.id) ?? 0);
              const displayName = agent.profile?.displayName ?? agent.id;
              const initial = initialOf(displayName);
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
                    {agent.slack?.avatarUrl ? (
                      <img
                        src={agent.slack.avatarUrl}
                        alt=""
                        className={[
                          'h-9 w-9 rounded-sm object-cover',
                          !enabled || notConnected ? 'opacity-40 grayscale' : '',
                        ].join(' ')}
                      />
                    ) : (
                      <span
                        className={[
                          'font-sans flex h-9 w-9 items-center justify-center rounded-sm text-[13px] font-bold text-white',
                          !enabled || notConnected ? 'opacity-40' : '',
                        ].join(' ')}
                        style={{ background: color }}
                      >
                        {initial}
                      </span>
                    )}
                    {/* Status dot — only when running */}
                    {enabled && !notConnected && isRunning && (
                      <span
                        className="absolute right-0.5 bottom-0.5 h-2 w-2 shrink-0 rounded-full border border-page"
                        style={{ background: 'var(--color-health-warn)' }}
                        title="working"
                      />
                    )}
                  </button>
                </div>
              );
            })}
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
          <div className="flex h-14 items-center gap-2.5 border-b border-spine-border px-5">
            <AnimaIcon className="h-4 w-4 text-accent" />
            <span className="display text-[18px] font-semibold tracking-tight text-text-on-spine">
              Anima
            </span>
            <span className="ml-auto h-6 w-6" aria-hidden />
          </div>

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
                      const active = pathname.startsWith(`/kb/${kb.id}`);
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
            <div className="space-y-0.5">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={reorderAgents}
              >
                <SortableContext
                  items={orderedAgents.map((a) => a.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {orderedAgents.map((agent) => (
                    <SortableItem key={agent.id} id={agent.id}>
                      <AgentRow
                        agent={agent}
                        index={agentIndexMap.get(agent.id) ?? 0}
                        active={agentId === agent.id}
                        isRunning={runningIds.has(agent.id)}
                        enabled={agent.enabled !== false}
                        onClick={() => setAgentId(agent.id)}
                      />
                    </SortableItem>
                  ))}
                </SortableContext>
              </DndContext>
              {orderedAgents.length === 0 && (
                <div className="px-2 py-4 text-center font-serif italic text-[12px] text-text-on-spine-subtle">
                  No agents configured
                </div>
              )}
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
        <AgentCreateModal onClose={() => setShowAddAgentModal(false)} />
      )}

      {serverPanelOpen && <ServerPanel onClose={() => setServerPanelOpen(false)} />}
    </>
  );
}
