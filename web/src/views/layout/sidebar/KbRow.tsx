import { FolderTree, MoreHorizontal } from 'lucide-react';
import type { KbView } from '@shared/kb';

// Match a KB only on a full path segment, so `/kb/quinn-curriculum` does not
// mark `/kb/quinn` active (a bare `startsWith` prefix-matches sibling ids).
export function isKbActive(pathname: string, id: string): boolean {
  const base = `/kb/${id}`;
  return pathname === base || pathname.startsWith(`${base}/`);
}

// ---------------------------------------------------------------------------
// KB row — icon tile + label, shared by the desktop sidebar and the mobile nav
// screen so the two lists stay one family. Colors are spine-side on both
// surfaces; `touch` switches to taller rows with grip clearance (mobile).
// The kebab (rename/delete) renders only when `onMenu` is provided.
// ---------------------------------------------------------------------------
export function KbRow({
  kb,
  active,
  onClick,
  onMenu,
  touch = false,
}: {
  kb: KbView;
  active: boolean;
  onClick: () => void;
  onMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  touch?: boolean;
}) {
  return (
    <div
      className={[
        'group relative flex w-full items-center rounded-sm transition-colors',
        active ? 'bg-spine-elevated' : 'hover:bg-spine-elevated/60',
      ].join(' ')}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-accent"
        />
      )}
      <button
        onClick={onClick}
        className={[
          'flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset',
          touch ? 'min-h-[44px] py-3 pl-6 pr-3' : 'px-3 py-2.5',
        ].join(' ')}
      >
        {/* Icon tile matches the agent-row avatar footprint (h-8 w-8)
            so KB and agent rows read as one family and align in height. */}
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] ring-1 ring-white/[0.06]">
          <FolderTree className="h-4 w-4 text-text-on-spine-muted" />
        </span>
        <span
          className={[
            'truncate font-serif leading-tight text-text-on-spine',
            touch ? 'text-[15px]' : 'text-[14px]',
            active ? 'font-semibold' : 'font-medium',
          ].join(' ')}
        >
          {kb.label}
        </span>
      </button>
      {onMenu && (
        <button
          onClick={onMenu}
          className="mr-1 flex min-h-[44px] w-8 shrink-0 items-center justify-center rounded-sm text-text-on-spine-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-spine-elevated hover:text-text-on-spine focus-visible:outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent"
          title="Knowledge Base options"
          aria-label="Knowledge Base options"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
