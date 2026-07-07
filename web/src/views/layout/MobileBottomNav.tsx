import { MessageSquare, FileText, Hash, Bell, User } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { parseLocation, AGENT_TABS, DEFAULT_TAB, type AgentTab } from '@/lib/url-state';

const NAV: { id: AgentTab; label: string; Icon: React.ElementType }[] = [
  { id: 'activity', label: 'Activity', Icon: MessageSquare },
  { id: 'files', label: 'Files', Icon: FileText },
  { id: 'channels', label: 'Channels', Icon: Hash },
  { id: 'reminders', label: 'Reminders', Icon: Bell },
  { id: 'profile', label: 'Profile', Icon: User },
];

/**
 * Fixed bottom nav shown on Screen 2 (agent detail) only:
 * Activity / Files / Channels / Reminders / Profile. Kb is a section on
 * Screen 1 (the nav list), not a bottom tab. Returns null on Screen 1.
 */
export default function MobileBottomNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { agentId, tab: parsedTab } = parseLocation(pathname);
  const tab: AgentTab = parsedTab && AGENT_TABS.includes(parsedTab) ? parsedTab : DEFAULT_TAB;
  const setTab = (next: AgentTab) => {
    if (!agentId) return;
    navigate(`/agents/${agentId}/${next}`);
  };
  // Screen 1 — nav list — has no bottom nav.
  if (!agentId) return null;

  return (
    <nav
      className="flex border-t border-border-soft bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 40 }}
    >
      {NAV.map((entry) => {
        const active = tab === entry.id;
        return (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            className={[
              'chrome relative flex flex-1 flex-col items-center gap-0.5 px-2 py-2.5 text-[10px] font-medium uppercase tracking-[0.1em] transition-colors',
              active ? 'text-text' : 'text-text-muted',
            ].join(' ')}
          >
            {active && (
              <span
                aria-hidden
                className="absolute top-0 left-3 right-3 h-[3px] rounded-b-[2px] bg-accent"
              />
            )}
            <entry.Icon className="h-5 w-5" />
            <span>{entry.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
