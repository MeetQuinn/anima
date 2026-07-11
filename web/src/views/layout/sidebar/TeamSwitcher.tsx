import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Pencil, Plus } from 'lucide-react';
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
//
// The menu is a floating card: soft-rounded, lifted on a real drop shadow. The
// current team reads from a faint elevated row (not the checkmark alone); a
// per-row edit affordance reveals on hover.
// ---------------------------------------------------------------------------
export function TeamSwitcher({
  teams,
  currentTeamId,
  onSelectTeam,
  onNewTeam,
  onEditTeam,
}: {
  teams: TeamConfig[];
  currentTeamId: string;
  onSelectTeam: (teamId: string) => void;
  onNewTeam: () => void;
  onEditTeam: (team: TeamConfig) => void;
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
          className="absolute left-2.5 right-2.5 top-[60px] z-30 origin-top overflow-hidden rounded-xl border border-white/10 bg-spine-elevated p-1.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.6)] ring-1 ring-black/10 animate-in fade-in slide-in-from-top-1 duration-150"
        >
          {grouped && (
            <>
              {teams.map((team) => {
                const active = team.id === current?.id;
                return (
                  <div
                    key={team.id}
                    className={[
                      'group/team relative flex items-center rounded-lg transition-colors',
                      active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.05]',
                    ].join(' ')}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onSelectTeam(team.id);
                        setOpen(false);
                      }}
                      className="flex min-w-0 flex-1 items-center rounded-lg py-2.5 pl-3 pr-9 text-left"
                    >
                      <span
                        className={[
                          'truncate font-sans text-[13.5px] leading-tight',
                          active
                            ? 'font-semibold text-text-on-spine'
                            : 'font-medium text-text-on-spine/90',
                        ].join(' ')}
                      >
                        {team.name}
                      </span>
                    </button>
                    {/* Current-team mark. Small and quiet on purpose — the elevated row
                        already carries the "you are here" signal; the tick just confirms it.
                        Fades out whenever a row control owns the slot: on hover, and on
                        keyboard focus-within (the edit button reveals via focus-visible, so
                        the check must clear it or the two overlap for keyboard users). */}
                    {active && (
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-accent/80 transition-opacity duration-100 group-hover/team:opacity-0 group-focus-within/team:opacity-0">
                        <Check className="h-3.5 w-3.5" />
                      </span>
                    )}
                    {/* Edit (rename / change home). Reveals on row hover; keyboard users
                        reach it by tab. Stops propagation so it never also selects the team. */}
                    <button
                      type="button"
                      aria-label={`Edit ${team.name}`}
                      title={`Edit ${team.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditTeam(team);
                        setOpen(false);
                      }}
                      className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-text-on-spine-muted opacity-0 transition-opacity duration-100 hover:bg-white/10 hover:text-text-on-spine focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent group-hover/team:opacity-100"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
              <div className="mx-2 my-1 h-px bg-white/10" />
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onNewTeam();
              setOpen(false);
            }}
            className="group/new flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05]"
          >
            <Plus className="h-4 w-4 shrink-0 text-accent" />
            <span className="truncate font-sans text-[13.5px] font-medium leading-tight text-text-on-spine">
              New team
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
