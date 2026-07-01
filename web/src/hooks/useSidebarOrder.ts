import { useMutation, useQuery } from '@tanstack/react-query';
import { useSensor, useSensors, PointerSensor, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { fetchAgents } from '@/api/agents';
import { fetchKbs } from '@/api/kb';
import { fetchSidebarOrder, saveSidebarOrder, type SidebarOrder } from '@/api/system';
import { queryClient } from '@/query-client';
import { queryKeys } from '@/lib/query-keys';
import { useTeams } from './useTeams';
import { effectiveTeamId, groupAgentsByTeam, isGrouped, type TeamGroup } from '@/lib/teams';

// ---------------------------------------------------------------------------
// applyOrder — reconcile a live list with a stored ordering.
// New items not in the stored order append to the end; stale IDs are ignored.
// ---------------------------------------------------------------------------
export function applyOrder<T>(
  items: T[],
  order: string[] | undefined,
  getId: (item: T) => string,
): T[] {
  if (!order?.length) return items;
  const orderMap = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ai = orderMap.get(getId(a)) ?? Infinity;
    const bi = orderMap.get(getId(b)) ?? Infinity;
    return ai - bi;
  });
}

// ---------------------------------------------------------------------------
// useSidebarOrder — shared hook for both Sidebar (desktop) and MobileNavScreen.
//
// Returns ordered agents + KBs, stable color index maps, drag sensors, and
// reorder handlers. Ordering is persisted to ANIMA_HOME/config.json with
// optimistic updates + rollback.
// ---------------------------------------------------------------------------
export function useSidebarOrder() {
  const { data: agents = [] } = useQuery({ queryKey: queryKeys.agents(), queryFn: fetchAgents });
  const { data: kbs = [] } = useQuery({ queryKey: queryKeys.kbs(), queryFn: fetchKbs });

  const { data: sidebarOrder } = useQuery({
    queryKey: queryKeys.sidebarOrder(),
    queryFn: fetchSidebarOrder,
    staleTime: Infinity,
  });

  const orderMutation = useMutation({
    mutationFn: saveSidebarOrder,
    onMutate: async (newOrder: SidebarOrder) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.sidebarOrder() });
      queryClient.setQueryData<SidebarOrder>(queryKeys.sidebarOrder(), newOrder);
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarOrder() });
    },
  });

  const teams = useTeams();

  const orderedAgents = applyOrder(agents, sidebarOrder?.agents, (a) => a.id);
  const orderedKbs = applyOrder(kbs, sidebarOrder?.kbs, (kb) => kb.id);

  // Team grouping is a display concern layered over the flat order. At N=1 the
  // list stays flat (identical to today); at N>=2 it groups by team.
  const grouped = isGrouped(teams);
  const teamIds = new Set(teams.map((t) => t.id));
  const groupedAgents: TeamGroup[] = groupAgentsByTeam(orderedAgents, teams);

  // Stable color index maps — color derives from original (unordered) position
  // so agent avatar color doesn't change when the user reorders.
  const agentIndexMap = new Map(agents.map((a, i) => [a.id, i]));
  const kbIndexMap = new Map(kbs.map((kb, i) => [kb.id, i]));

  // PointerSensor distance:4 lets regular taps/clicks pass through on both
  // mouse and touch surfaces.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function reorderAgents(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = orderedAgents.findIndex((a) => a.id === String(active.id));
    const newIdx = orderedAgents.findIndex((a) => a.id === String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    // In grouped mode, drag only reorders within a team. Moving an agent to a
    // different team is an explicit action (the row's team menu), never a drag,
    // so a cross-group drop is a no-op that snaps back.
    if (
      grouped &&
      effectiveTeamId(orderedAgents[oldIdx], teamIds) !==
        effectiveTeamId(orderedAgents[newIdx], teamIds)
    ) {
      return;
    }
    const reordered = arrayMove(orderedAgents, oldIdx, newIdx);
    void orderMutation.mutate({ ...sidebarOrder, agents: reordered.map((a) => a.id) });
  }

  function reorderKbs(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = orderedKbs.findIndex((kb) => kb.id === String(active.id));
    const newIdx = orderedKbs.findIndex((kb) => kb.id === String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(orderedKbs, oldIdx, newIdx);
    void orderMutation.mutate({ ...sidebarOrder, kbs: reordered.map((kb) => kb.id) });
  }

  return {
    orderedAgents,
    orderedKbs,
    groupedAgents,
    grouped,
    teams,
    agentIndexMap,
    kbIndexMap,
    sensors,
    reorderAgents,
    reorderKbs,
  };
}
