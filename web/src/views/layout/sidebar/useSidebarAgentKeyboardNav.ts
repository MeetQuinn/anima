import { useEffect, useRef, useState } from 'react';

// Keyboard navigation for the expanded sidebar agent list.
//
// Model: an ARIA listbox with selection that FOLLOWS FOCUS (like the macOS
// mail list or Slack's channel switcher). ArrowUp/ArrowDown move a keyboard
// cursor through the agents and switch the active agent. Because switching an
// agent remounts the activity view and kicks off a fresh data fetch, the
// actual commit (navigate) is debounced: holding or rapidly tapping the arrows
// moves the highlight instantly but only the agent you land on is opened, so
// scanning the list doesn't fire a burst of mounts/refetches. A single press
// still feels instant. Enter/Space flush the commit immediately.
//
// Focus stays on the list container (aria-activedescendant pattern); the rows
// themselves are not tab stops. dnd-kit here uses PointerSensor only, so the
// arrow keys don't collide with keyboard drag-reordering.

const COMMIT_DELAY_MS = 120;

const AGENT_OPTION_ID_PREFIX = 'sidebar-agent-opt-';
export const agentOptionId = (agentId: string): string => `${AGENT_OPTION_ID_PREFIX}${agentId}`;

export function useSidebarAgentKeyboardNav({
  agentIds,
  activeAgentId,
  onCommit,
}: {
  agentIds: string[];
  activeAgentId: string | null;
  onCommit: (agentId: string) => void;
}) {
  // The keyboard cursor. Non-null ONLY during the brief window between an arrow
  // press and its debounced commit; otherwise it falls back to the active agent
  // so the highlight always tracks whatever is actually open (incl. external
  // navigation), with no stale state to reconcile in an effect.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [listFocused, setListFocused] = useState(false);
  const commitTimer = useRef<number | null>(null);

  const effectiveCursorId = cursorId ?? activeAgentId ?? agentIds[0] ?? null;

  useEffect(
    () => () => {
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current);
    },
    [],
  );

  const clearTimer = () => {
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
  };

  const scheduleCommit = (id: string) => {
    clearTimer();
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = null;
      setCursorId(null);
      onCommit(id);
    }, COMMIT_DELAY_MS);
  };

  const commitNow = (id: string) => {
    clearTimer();
    setCursorId(null);
    onCommit(id);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (agentIds.length === 0) return;
    const current = cursorId ?? activeAgentId ?? agentIds[0];
    const idx = Math.max(0, agentIds.indexOf(current));
    let nextIdx: number;
    switch (event.key) {
      case 'ArrowDown':
        nextIdx = Math.min(agentIds.length - 1, idx + 1);
        break;
      case 'ArrowUp':
        nextIdx = Math.max(0, idx - 1);
        break;
      case 'Home':
        nextIdx = 0;
        break;
      case 'End':
        nextIdx = agentIds.length - 1;
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        commitNow(current);
        return;
      default:
        return;
    }
    event.preventDefault();
    const nextId = agentIds[nextIdx];
    setCursorId(nextId);
    // Keep the cursor row in view within the sidebar scroll region. ids are
    // unique so a direct lookup avoids threading refs through every row.
    document.getElementById(agentOptionId(nextId))?.scrollIntoView({ block: 'nearest' });
    scheduleCommit(nextId);
  };

  // A mouse click lands DOM focus on the clicked row's inner button. The
  // keyboard model expects focus to live on the list container (rows are not
  // tab stops), so pull focus back to the container after a click. Otherwise
  // the stale button keeps :focus-visible and, on the next arrow press (which
  // flips the modality to keyboard), lights an accent ring on the agent you
  // just navigated AWAY from. Click bubbles after the row's own onClick, so
  // navigation has already fired by the time we refocus.
  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.currentTarget.focus();
  };

  const onFocus = () => setListFocused(true);
  const onBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    // React's onBlur bubbles; only drop focus when it leaves the list entirely.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setListFocused(false);
    }
  };

  return {
    listboxProps: {
      role: 'listbox' as const,
      'aria-orientation': 'vertical' as const,
      tabIndex: 0,
      'aria-activedescendant':
        listFocused && effectiveCursorId ? agentOptionId(effectiveCursorId) : undefined,
      onKeyDown,
      onClick,
      onFocus,
      onBlur,
    },
    // The keyboard cursor highlight only shows while the list has focus, so an
    // unfocused sidebar doesn't render a permanent ring on the active row.
    isOptionFocused: (id: string): boolean => listFocused && effectiveCursorId === id,
  };
}
