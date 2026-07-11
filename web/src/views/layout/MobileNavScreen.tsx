import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Gauge, GripVertical, Pencil, Plus, Server } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import AnimaIcon from '@/components/AnimaIcon';
import { queryClient } from '@/query-client';
import { queryKeys } from '@/lib/query-keys';
import { useAgentStatuses } from '@/hooks/useAgentDirectory';
import { useSidebarOrder } from '@/hooks/useSidebarOrder';
import { useCurrentTeam, useTeams } from '@/hooks/useTeams';
import { useUpdateAvailable } from '@/hooks/useRuntimeUpgrade';
import ServerPanel from '@/components/ServerPanel';
import UsagePanel from '@/components/UsagePanel';
import { AgentCreateModal, AddKbModal } from './Sidebar';
import { AgentRow } from './sidebar/AgentRow';
import { KbRow, isKbActive } from './sidebar/KbRow';
import { CreateTeamModal, EditTeamModal } from './sidebar/TeamModals';
import type { TeamConfig } from '@/api/teams';

const MOBILE_SCROLL_KEY = 'mobile-nav-scroll';

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
        className="pointer-events-none absolute left-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-on-spine-subtle opacity-35"
      />
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MobileNavScreen — Screen 1 of the mobile layout.
//
// The desktop sidebar rendered as a full page: same dark spine, same rows.
// KB entries first, then all agents, both respecting the saved sidebar order
// and supporting drag-to-reorder. Rows are the shared sidebar components
// (AgentRow / KbRow) in their `touch` size, so desktop restyles carry over
// here for free. Scroll position is preserved in sessionStorage.
// ---------------------------------------------------------------------------
export default function MobileNavScreen({
  onSelectAgent,
  lastSelectedId,
}: {
  onSelectAgent: (id: string) => void;
  lastSelectedId?: string | null;
}) {
  const teams = useTeams();
  const { currentTeamId, setCurrentTeamId } = useCurrentTeam(teams);
  const { orderedAgents, orderedKbs, agentIndexMap, sensors, reorderAgents, reorderKbs } =
    useSidebarOrder(currentTeamId);
  const location = useLocation();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showAddAgentModal, setShowAddAgentModal] = useState(false);
  const [showAddKbModal, setShowAddKbModal] = useState(false);
  const [showTeamMenu, setShowTeamMenu] = useState(false);
  const [showCreateTeamModal, setShowCreateTeamModal] = useState(false);
  const [editTeam, setEditTeam] = useState<TeamConfig | null>(null);
  const [serverPanelOpen, setServerPanelOpen] = useState(false);
  const [usagePanelOpen, setUsagePanelOpen] = useState(false);
  const multiTeam = teams.length > 1;
  const currentTeam = teams.find((t) => t.id === currentTeamId) ?? teams[0];
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

  const { data: statuses = [] } = useAgentStatuses({ poll: true });
  const runningIds = new Set(
    statuses.filter((s) => s.currentItemId || s.queueDepth > 0).map((s) => s.agentId),
  );
  const statusByAgentId = new Map(statuses.map((status) => [status.agentId, status]));

  return (
    // `spine-shelf` remaps the spine tokens to the sunken-paper palette (see
    // index.css): full-screen dark spine read as a page of chrome on mobile.
    <div className="spine-shelf flex h-dvh flex-col bg-page md:hidden">
      {/* Sticky header — tap to switch teams or create one. At N=1 it shows the
          Anima wordmark with a faint caret (still tappable, so "New team" is
          reachable on mobile); at N>=2 it shows the current team name and the
          menu lists teams to switch/edit. */}
      <div
        className="relative flex h-14 shrink-0 items-center border-b border-spine-border bg-page"
        style={{ position: 'sticky', top: 0, zIndex: 10 }}
      >
        <button
          type="button"
          onClick={() => setShowTeamMenu((v) => !v)}
          className="flex h-full w-full items-center gap-2.5 px-5 text-left transition-colors hover:bg-spine-elevated/60"
          aria-haspopup="menu"
          aria-expanded={showTeamMenu}
          title={multiTeam ? `Team: ${currentTeam?.name ?? 'Anima'}` : 'Anima'}
        >
          <AnimaIcon className="h-4 w-4 shrink-0 text-accent" />
          <span className="display min-w-0 truncate text-[18px] font-semibold tracking-tight text-text-on-spine">
            {multiTeam ? currentTeam?.name ?? 'Anima' : 'Anima'}
          </span>
          <ChevronDown
            className={[
              'h-4 w-4 shrink-0 text-text-on-spine-muted transition-all duration-150',
              showTeamMenu ? 'rotate-180 opacity-100' : multiTeam ? 'opacity-70' : 'opacity-30',
            ].join(' ')}
          />
        </button>

        {showTeamMenu && (
          <>
            {/* Backdrop closes the menu on any outside tap. */}
            <div
              className="fixed inset-0 z-20"
              onClick={() => setShowTeamMenu(false)}
              role="presentation"
            />
            {/* Floating card mirrors the desktop TeamSwitcher menu, with 44px
                touch rows and an always-visible edit pencil (no hover here).
                On the shelf tone the card is lifted paper (raised bg, warm
                shadow) rather than the desktop menu's dark elevation. */}
            <div
              role="menu"
              className="absolute left-2.5 right-2.5 top-[60px] z-30 origin-top overflow-hidden rounded-xl border border-border-soft bg-surface-raised p-1.5 shadow-deep ring-1 ring-black/5 animate-in fade-in slide-in-from-top-1 duration-150"
            >
              {/* Team list (only when there is more than one team to switch between). */}
              {multiTeam && (
                <>
                  {teams.map((team) => {
                    const active = team.id === currentTeam?.id;
                    return (
                      <div
                        key={team.id}
                        className={[
                          'relative flex items-center rounded-lg transition-colors',
                          active ? 'bg-surface-elevated' : 'hover:bg-surface-hover/60',
                        ].join(' ')}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setCurrentTeamId(team.id);
                            setShowTeamMenu(false);
                          }}
                          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg py-2.5 pl-3 pr-2 text-left"
                        >
                          <span
                            className={[
                              'min-w-0 truncate font-sans text-[14px] leading-tight',
                              active
                                ? 'font-semibold text-text-on-spine'
                                : 'font-medium text-text-on-spine/90',
                            ].join(' ')}
                          >
                            {team.name}
                          </span>
                          {active && (
                            <Check className="h-3.5 w-3.5 shrink-0 text-accent/80" />
                          )}
                        </button>
                        {/* Edit (rename / change home). Always visible on touch (no hover);
                            stops propagation so it never also switches the team. */}
                        <button
                          type="button"
                          aria-label={`Edit ${team.name}`}
                          title={`Edit ${team.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditTeam(team);
                            setShowTeamMenu(false);
                          }}
                          className="mr-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-on-spine-muted hover:bg-surface-hover hover:text-text-on-spine"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                  <div className="mx-2 my-1 h-px bg-border-soft" />
                </>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setShowCreateTeamModal(true);
                  setShowTeamMenu(false);
                }}
                className="flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-hover/60"
              >
                <Plus className="h-4 w-4 shrink-0 text-accent" />
                <span className="truncate font-sans text-[14px] font-medium leading-tight text-text-on-spine">
                  New team
                </span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* Scrollable nav list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3">
        {/* Knowledge Base section */}
        <div className="mb-4">
          <div className="mb-2 flex items-center justify-between pl-3">
            <span className="caps text-text-on-spine-subtle">Knowledge Base</span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] tabular-nums text-text-on-spine-subtle/70">
                {orderedKbs.length}
              </span>
              <button
                onClick={() => setShowAddKbModal(true)}
                className="flex h-11 w-11 items-center justify-center rounded-sm text-text-on-spine-muted hover:bg-spine-elevated hover:text-text-on-spine"
                aria-label="Add Knowledge Base"
                title="Add Knowledge Base"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderKbs}>
            <SortableContext items={orderedKbs.map((kb) => kb.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-0.5">
                {orderedKbs.map((kb) => (
                  <MobileSortableItem key={kb.id} id={kb.id}>
                    <KbRow
                      kb={kb}
                      active={isKbActive(location.pathname, kb.id)}
                      onClick={() => handleSelectKb(kb.id)}
                      touch
                    />
                  </MobileSortableItem>
                ))}
                {orderedKbs.length === 0 && (
                  <button
                    onClick={() => setShowAddKbModal(true)}
                    className="flex items-center gap-1.5 px-2 font-sans text-[11px] text-text-on-spine-subtle hover:text-text-on-spine"
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
          <div className="mb-2 flex items-center justify-between pl-3">
            <span className="caps text-text-on-spine-subtle">Agents</span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] tabular-nums text-text-on-spine-subtle/70">
                {orderedAgents.length}
              </span>
              <button
                onClick={() => setShowAddAgentModal(true)}
                className="flex h-11 w-11 items-center justify-center rounded-sm text-text-on-spine-muted hover:bg-spine-elevated hover:text-text-on-spine"
                aria-label="Add agent"
                title="Add agent"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderAgents}>
            <SortableContext items={orderedAgents.map((a) => a.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-0.5">
                {orderedAgents.map((agent) => {
                  const status = statusByAgentId.get(agent.id);
                  return (
                    <MobileSortableItem key={agent.id} id={agent.id}>
                      <AgentRow
                        agent={agent}
                        index={agentIndexMap.get(agent.id) ?? 0}
                        active={agent.id === lastSelectedId}
                        isRunning={runningIds.has(agent.id)}
                        enabled={agent.enabled !== false}
                        {...(status ? { status } : {})}
                        onClick={() => handleSelectAgent(agent.id)}
                        touch
                      />
                    </MobileSortableItem>
                  );
                })}
                {orderedAgents.length === 0 && (
                  <button
                    onClick={() => setShowAddAgentModal(true)}
                    className="flex items-center gap-1.5 px-2 font-sans text-[11px] text-text-on-spine-subtle hover:text-text-on-spine"
                  >
                    <Plus className="h-3 w-3" />
                    Add agent
                  </button>
                )}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {/* Usage + Server — pinned footer, one row split in half so it stays
          shallow. Usage left (the frequently checked one), Server right. */}
      <div
        className="flex shrink-0 gap-1 border-t border-spine-border px-2 pt-1"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.25rem)' }}
      >
        <button
          onClick={() => setUsagePanelOpen(true)}
          title="Provider usage"
          className="chrome flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-sm px-2.5 text-[11px] uppercase tracking-[0.1em] text-text-on-spine-muted transition-colors hover:bg-spine-elevated hover:text-text-on-spine"
        >
          <Gauge className="h-3.5 w-3.5" />
          <span>Usage</span>
        </button>
        <button
          onClick={() => setServerPanelOpen(true)}
          title={updateAvailable ? 'Server — update available' : 'Server status & restart'}
          className="chrome flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-sm px-2.5 text-[11px] uppercase tracking-[0.1em] text-text-on-spine-muted transition-colors hover:bg-spine-elevated hover:text-text-on-spine"
        >
          <Server className="h-3.5 w-3.5" />
          <span>Server</span>
          {updateAvailable && (
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-accent"
              title="Update available"
            />
          )}
        </button>
      </div>

      {showAddAgentModal && (
        <AgentCreateModal
          onClose={() => setShowAddAgentModal(false)}
          teams={teams}
          defaultTeamId={currentTeamId}
        />
      )}
      {showAddKbModal && (
        <AddKbModal
          teamId={currentTeamId}
          onClose={() => setShowAddKbModal(false)}
          onAdded={() => {
            setShowAddKbModal(false);
            queryClient.invalidateQueries({ queryKey: queryKeys.kbs() });
          }}
        />
      )}
      {serverPanelOpen && <ServerPanel onClose={() => setServerPanelOpen(false)} />}
      {usagePanelOpen && <UsagePanel onClose={() => setUsagePanelOpen(false)} />}

      {showCreateTeamModal && (
        <CreateTeamModal
          onClose={() => setShowCreateTeamModal(false)}
          // Switch the mobile list to the freshly created team (mirrors desktop).
          onCreated={(team) => setCurrentTeamId(team.id)}
        />
      )}
      {editTeam && (
        <EditTeamModal
          team={editTeam}
          onClose={() => setEditTeam(null)}
          // Editing is navigation-neutral: renaming refreshes the label via query
          // invalidation; it never yanks you into another team. Just close.
          onSaved={() => setEditTeam(null)}
        />
      )}
    </div>
  );
}
