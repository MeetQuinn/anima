import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderTree, GripVertical, Plus, Server } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import AnimaIcon from '@/components/AnimaIcon';
import { fetchAgentStatuses } from '@/api/agents';
import { queryClient } from '@/query-client';
import { queryKeys, refetchIntervals } from '@/lib/query-keys';
import { useSidebarOrder } from '@/hooks/useSidebarOrder';
import { useUpdateAvailable } from '@/hooks/useRuntimeUpgrade';
import ServerPanel from '@/components/ServerPanel';
import type { AgentRuntimeHealthSummary } from '@shared/snapshot';
import { AgentCreateModal, AddKbModal } from './Sidebar';
import { agentColor, initialOf } from '@/lib/avatars';
import {
  agentHasConnectedTransport,
} from '@shared/agent-transports';

const MOBILE_SCROLL_KEY = 'mobile-nav-scroll';

// Single colored dot helpers — mirrors the desktop sidebar logic.
function mobileDotColor(health: AgentRuntimeHealthSummary | undefined, isRunning: boolean): string {
  if (!health || health.state === 'unknown' || health.state === 'starting' || health.state === 'degraded') {
    return 'var(--color-health-idle)';
  }
  if (health.state === 'unhealthy') return 'var(--color-health-error)';
  return isRunning ? 'var(--color-health-warn)' : 'var(--color-health-ok)';
}

function mobileDotTitle(health: AgentRuntimeHealthSummary | undefined, isRunning: boolean): string {
  if (!health || health.state === 'unknown') return 'health unavailable';
  if (health.state === 'starting') return 'starting';
  if (health.state === 'degraded') return 'retrying';
  if (health.state === 'unhealthy') return 'needs attention';
  return isRunning ? 'working' : 'idle';
}

// ---------------------------------------------------------------------------
// MobileSortableItem — drag wrapper for mobile rows.
// Grip icon is always visible at low opacity (no hover on touch surfaces).
// ---------------------------------------------------------------------------
function MobileSortableItem({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition: transition ?? undefined }}
      {...attributes}
      {...listeners}
      className={['group/drag relative select-none', isDragging ? 'z-50 opacity-40' : ''].join(' ')}
    >
      <GripVertical
        aria-hidden
        className="pointer-events-none absolute left-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-subtle opacity-35"
      />
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MobileNavScreen — Screen 1 of the mobile layout.
//
// Mirrors the desktop sidebar: Knowledge Base entries first, then all agents,
// both respecting the saved sidebar order and supporting drag-to-reorder.
// Scroll position is preserved in sessionStorage.
// ---------------------------------------------------------------------------
export default function MobileNavScreen({
  onSelectAgent,
  lastSelectedId,
}: {
  onSelectAgent: (id: string) => void;
  lastSelectedId?: string | null;
}) {
  const { orderedAgents, orderedKbs, agentIndexMap, sensors, reorderAgents, reorderKbs } = useSidebarOrder();
  const location = useLocation();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showAddAgentModal, setShowAddAgentModal] = useState(false);
  const [showAddKbModal, setShowAddKbModal] = useState(false);
  const [serverPanelOpen, setServerPanelOpen] = useState(false);
  // Resting indicator — accent dot on the Server footer when a system update is
  // available, matching the desktop sidebar. This is the only mobile entry to the
  // Server panel (MobileTopBar routes here), so without it a mobile user gets no
  // resting hint that an update exists. Reuses the panel's deduped query (no extra
  // request); clears once the user upgrades.
  const updateAvailable = useUpdateAvailable();
  // Restore scroll position when returning from detail screen.
  useEffect(() => {
    const saved = sessionStorage.getItem(MOBILE_SCROLL_KEY);
    if (saved && scrollRef.current) {
      scrollRef.current.scrollTop = Number(saved);
    }
  }, []);

  const handleSelectAgent = (id: string) => {
    if (scrollRef.current) {
      sessionStorage.setItem(MOBILE_SCROLL_KEY, String(scrollRef.current.scrollTop));
    }
    onSelectAgent(id);
  };

  const handleSelectKb = (id: string) => {
    if (scrollRef.current) {
      sessionStorage.setItem(MOBILE_SCROLL_KEY, String(scrollRef.current.scrollTop));
    }
    navigate(`/kb/${id}`);
  };

  const { data: statuses = [] } = useQuery({
    queryKey: queryKeys.agentStatuses(),
    queryFn: fetchAgentStatuses,
    refetchInterval: refetchIntervals.agentStatuses,
  });
  const runningIds = new Set(
    statuses.filter((s) => s.currentItemId || s.queueDepth > 0).map((s) => s.agentId),
  );
  const statusByAgentId = new Map(statuses.map((status) => [status.agentId, status]));

  return (
    <div className="flex h-dvh flex-col bg-surface md:hidden">
      {/* Sticky header */}
      <div
        className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border-soft bg-surface px-5"
        style={{ position: 'sticky', top: 0, zIndex: 10 }}
      >
        <AnimaIcon className="h-4 w-4 text-accent" />
        <span className="display text-[18px] font-semibold tracking-tight text-text">Anima</span>
      </div>

      {/* Scrollable nav list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3">
        {/* Knowledge Base section */}
        <div className="mb-4">
          <div className="mb-2 flex items-center gap-1.5 px-3">
            <span className="caps text-text-muted">Knowledge Base</span>
            <span className="font-mono text-[10px] text-text-muted">{orderedKbs.length}</span>
            <button
              onClick={() => setShowAddKbModal(true)}
              className="ml-auto flex min-h-[44px] min-w-[44px] items-center justify-end rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text"
              aria-label="Add Knowledge Base"
              title="Add Knowledge Base"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderKbs}>
            <SortableContext items={orderedKbs.map((kb) => kb.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-0.5">
                {orderedKbs.map((kb) => {
                  const active = location.pathname.startsWith(`/kb/${kb.id}`);
                  return (
                    <MobileSortableItem key={kb.id} id={kb.id}>
                      <button
                        onClick={() => handleSelectKb(kb.id)}
                        className={[
                          'relative flex min-h-[44px] w-full items-center gap-2.5 rounded-sm py-3 pl-6 pr-3 text-left transition-colors',
                          active ? 'bg-surface-elevated' : 'hover:bg-surface-elevated/60',
                        ].join(' ')}
                      >
                        {active && (
                          <span aria-hidden className="absolute left-0 top-2 bottom-2 w-px bg-accent" />
                        )}
                        <FolderTree className="h-4 w-4 shrink-0 text-text-muted" />
                        <span
                          className={[
                            'truncate font-serif text-[15px] leading-tight text-text',
                            active ? 'font-semibold' : 'font-medium',
                          ].join(' ')}
                        >
                          {kb.label}
                        </span>
                      </button>
                    </MobileSortableItem>
                  );
                })}
                {orderedKbs.length === 0 && (
                  <button
                    onClick={() => setShowAddKbModal(true)}
                    className="flex items-center gap-1.5 px-2 font-sans text-[11px] text-text-muted hover:text-text"
                  >
                    <Plus className="h-3 w-3" />
                    Add Knowledge Base
                  </button>
                )}
              </div>
            </SortableContext>
          </DndContext>
        </div>

        {/* Agents section */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 px-3">
            <span className="caps text-text-muted">Agents</span>
            <span className="font-mono text-[10px] text-text-muted">{orderedAgents.length}</span>
            <button
              onClick={() => setShowAddAgentModal(true)}
              className="ml-auto flex min-h-[44px] min-w-[44px] items-center justify-end rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text"
              aria-label="Add agent"
              title="Add agent"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderAgents}>
            <SortableContext items={orderedAgents.map((a) => a.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-0.5">
                {orderedAgents.map((agent) => {
                  const color = agentColor(agentIndexMap.get(agent.id) ?? 0);
                  const name = agent.profile?.displayName ?? agent.id;
                  const initial = initialOf(name);
                  const isRunning = runningIds.has(agent.id);
                  const enabled = agent.enabled !== false;
                  const notConnected = enabled && !agentHasConnectedTransport(agent);
                  const status = statusByAgentId.get(agent.id);
                  const isSelected = agent.id === lastSelectedId;
                  const showRuntimeHealth = enabled && !notConnected;
                  const showRightMeta = !enabled || showRuntimeHealth;

                  return (
                    <MobileSortableItem key={agent.id} id={agent.id}>
                      <button
                        onClick={() => handleSelectAgent(agent.id)}
                        className={[
                          'relative flex min-h-[44px] w-full items-center gap-2.5 rounded-sm py-3 pl-6 pr-3 text-left transition-colors',
                          isSelected ? 'bg-surface-elevated' : 'hover:bg-surface-elevated/60',
                        ].join(' ')}
                      >
                        {isSelected && (
                          <span aria-hidden className="absolute left-0 top-2 bottom-2 w-0.5 bg-accent" />
                        )}
                        {agent.slack?.avatarUrl ? (
                          <img
                            src={agent.slack.avatarUrl}
                            alt=""
                            className="h-6 w-6 shrink-0 rounded-lg object-cover ring-1 ring-border-soft"
                            style={{ opacity: enabled ? 1 : 0.45 }}
                          />
                        ) : (
                          <span
                            className="font-sans flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-white ring-1 ring-border-soft"
                            style={{ background: color, opacity: enabled ? 1 : 0.45 }}
                          >
                            {initial}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span
                            className={[
                              'block truncate font-serif text-[15px] font-medium leading-tight',
                              enabled ? 'text-text' : 'text-text-muted',
                            ].join(' ')}
                          >
                            {name}
                          </span>
                          {notConnected && (
                            <span className="font-sans mt-0.5 block text-[10px] leading-tight text-health-warn/80">
                              Not connected
                            </span>
                          )}
                        </span>
                        {showRightMeta && (
                          <span className="ml-auto flex shrink-0 items-center gap-1.5">
                            {!enabled ? (
                              <span className="font-sans shrink-0 rounded-sm border border-text-muted/30 px-1 py-0.5 text-[9px] uppercase tracking-[0.08em] text-text-muted">
                                Off
                              </span>
                            ) : showRuntimeHealth ? (
                              <span
                                aria-hidden
                                className="h-2 w-2 shrink-0 rounded-full"
                                title={mobileDotTitle(status?.health, isRunning)}
                                style={{ background: mobileDotColor(status?.health, isRunning) }}
                              />
                            ) : null}
                          </span>
                        )}
                      </button>
                    </MobileSortableItem>
                  );
                })}
                {orderedAgents.length === 0 && (
                  <div className="px-2 py-6 text-center font-serif italic text-[13px] text-text-muted">
                    No agents configured
                  </div>
                )}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {/* Server entry — pinned footer */}
      <div
        className="shrink-0 border-t border-border-soft px-2 pb-2 pt-1"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.5rem)' }}
      >
        <button
          onClick={() => setServerPanelOpen(true)}
          title={updateAvailable ? 'Server — update available' : 'Server status & restart'}
          className="flex min-h-[44px] w-full items-center gap-2.5 rounded-sm px-3 py-2 text-left transition-colors hover:bg-surface-elevated/60"
        >
          <Server className="h-4 w-4 shrink-0 text-text-muted" />
          <span className="font-serif text-[15px] font-medium leading-tight text-text-muted">
            Server
          </span>
          {updateAvailable && (
            <span
              aria-hidden
              className="ml-auto h-1.5 w-1.5 rounded-full bg-accent"
              title="Update available"
            />
          )}
        </button>
      </div>

      {showAddAgentModal && (
        <AgentCreateModal onClose={() => setShowAddAgentModal(false)} />
      )}
      {showAddKbModal && (
        <AddKbModal
          onClose={() => setShowAddKbModal(false)}
          onAdded={() => {
            setShowAddKbModal(false);
            queryClient.invalidateQueries({ queryKey: queryKeys.kbs() });
          }}
        />
      )}
      {serverPanelOpen && <ServerPanel onClose={() => setServerPanelOpen(false)} />}
    </div>
  );
}
