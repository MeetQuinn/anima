import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import AnimaIcon from '@/components/AnimaIcon';
import type { TeamConfig } from '@/api/teams';

// ---------------------------------------------------------------------------
// TeamSwitcher — the top-left header of the expanded sidebar.
//
// N=1 (single team): visually identical to today. Renders the Anima wordmark
//   with no resting caret and no team chrome. It is quietly clickable so the
//   "+ New team" entry stays discoverable, but at rest looks exactly the same.
// N>=2 (grouped): shows the current working-team name + a caret. The menu
//   lists every team (click = set working context, never a visibility filter)
//   and the "+ New team" action.
// ---------------------------------------------------------------------------
export function TeamSwitcher({
  teams,
  currentTeamId,
  onSelectTeam,
  onNewTeam,
}: {
  teams: TeamConfig[];
  currentTeamId: string;
  onSelectTeam: (teamId: string) => void;
  onNewTeam: () => void;
}) {
  const grouped = teams.length > 1;
  const current = teams.find((t) => t.id === currentTeamId) ?? teams[0];
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = grouped ? current?.name ?? 'Anima' : 'Anima';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex h-14 w-full items-center gap-2 border-b border-spine-border pl-5 pr-12 text-left transition-colors hover:bg-spine-elevated/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        aria-haspopup="menu"
        aria-expanded={open}
        title={grouped ? `Team: ${label}` : 'Anima'}
      >
        <AnimaIcon className="h-4 w-4 shrink-0 text-accent" />
        <span className="display min-w-0 truncate text-[18px] font-semibold tracking-tight text-text-on-spine">
          {label}
        </span>
        {/* Caret sits right next to the name (not at the far edge, where the
            sidebar-collapse control lives). Rests faint in single-team mode,
            brightens on hover, and rotates when the menu is open. */}
        <ChevronDown
          className={[
            'h-4 w-4 shrink-0 text-text-on-spine-muted transition-all duration-150',
            open
              ? 'rotate-180 opacity-100'
              : grouped
                ? 'opacity-70'
                : 'opacity-30 group-hover:opacity-70',
          ].join(' ')}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-3 right-3 top-[52px] z-30 overflow-hidden rounded-sm border border-white/20 bg-spine-elevated py-1 shadow-deep ring-1 ring-black/20"
        >
          {grouped && (
            <>
              {teams.map((team) => {
                const active = team.id === current?.id;
                return (
                  <button
                    key={team.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onSelectTeam(team.id);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-[13px] text-text-on-spine hover:bg-white/5"
                  >
                    <Check
                      className={[
                        'h-3.5 w-3.5 shrink-0',
                        active ? 'text-accent' : 'text-transparent',
                      ].join(' ')}
                    />
                    <span className="truncate">{team.name}</span>
                  </button>
                );
              })}
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onNewTeam();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-sans text-[13px] font-medium text-text-on-spine hover:bg-white/5"
          >
            <Plus className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span>New team</span>
          </button>
        </div>
      )}
    </div>
  );
}
