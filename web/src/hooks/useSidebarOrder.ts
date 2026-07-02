import { useMutation, useQuery } from '@tanstack/react-query';
import { useSensor, useSensors, PointerSensor, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { fetchAgents } from '@/api/agents';
import { fetchKbs } from '@/api/kb';
import { fetchSidebarOrder, saveSidebarOrder, type SidebarOrder } from '@/api/system';
import { queryClient } from '@/query-client';
import { queryKeys } from '@/lib/query-keys';
import { useTeams } from './useTeams';
import { effectiveTeamId } from '@/lib/teams';

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

// Splice a reordered subset back into the full ordered list, leaving every
// non-subset item exactly where it was. Used so reordering the current team's
// items never disturbs other teams' persisted order.
function spliceSubset<T>(full: T[], reorderedSubset: T[], inSubset: (item: T) => boolean): T[] {
  const queue = [...reorderedSubset];
  return full.map((item) => (inSubset(item) ? (queue.shift() as T) : item));
}

// ---------------------------------------------------------------------------
// useSidebarOrder — shared hook for both Sidebar (desktop) and MobileNavScreen.
//
// Scopes the sidebar to a single team: only agents + KBs owned by
// `currentTeamId` are returned. Ordering is still persisted globally (one flat
// order per config.json) with optimistic updates + rollback; reorders happen
// against the full list so other teams' order is preserved.
// ---------------------------------------------------------------------------
export function useSidebarOrder(currentTeamId: string) {
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
  const teamIds = new Set(teams.map((t) => t.id));

  // Full ordered lists (all teams) — the persisted order lives here.
  const orderedAgentsAll = applyOrder(agents, sidebarOrder?.agents, (a) => a.id);
  const orderedKbsAll = applyOrder(kbs, sidebarOrder?.kbs, (kb) => kb.id);

  // The sidebar only ever shows the current team's agents + KBs.
  const agentInTeam = (a: (typeof orderedAgentsAll)[number]) =>
    effectiveTeamId(a, teamIds) === currentTeamId;
  const kbInTeam = (kb: (typeof orderedKbsAll)[number]) => kb.teamId === currentTeamId;

  const orderedAgents = orderedAgentsAll.filter(agentInTeam);
  const orderedKbs = orderedKbsAll.filter(kbInTeam);

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
    const reorderedSubset = arrayMove(orderedAgents, oldIdx, newIdx);
    const nextFull = spliceSubset(orderedAgentsAll, reorderedSubset, agentInTeam);
    void orderMutation.mutate({ ...sidebarOrder, agents: nextFull.map((a) => a.id) });
  }

  function reorderKbs(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = orderedKbs.findIndex((kb) => kb.id === String(active.id));
    const newIdx = orderedKbs.findIndex((kb) => kb.id === String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const reorderedSubset = arrayMove(orderedKbs, oldIdx, newIdx);
    const nextFull = spliceSubset(orderedKbsAll, reorderedSubset, kbInTeam);
    void orderMutation.mutate({ ...sidebarOrder, kbs: nextFull.map((kb) => kb.id) });
  }

  return {
    orderedAgents,
    orderedKbs,
    agentIndexMap,
    kbIndexMap,
    sensors,
    reorderAgents,
    reorderKbs,
  };
}
