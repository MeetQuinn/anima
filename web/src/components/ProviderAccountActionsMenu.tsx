import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Trash2 } from 'lucide-react';

import type { ProviderAccountSummary } from '@shared/provider-accounts';

interface Props {
  account: ProviderAccountSummary;
  name: string;
  onRemove: (account: ProviderAccountSummary) => void;
}

/** Account-scoped overflow actions; keep rare and future account actions here. */
export default function ProviderAccountActionsMenu({ account, name, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const removable = account.profile === 'isolated' && !account.selected;
  const unavailableReason = account.profile === 'default'
    ? 'Primary account cannot be removed.'
    : 'Switch accounts before removing.';

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div
      className="relative shrink-0"
      ref={menuRef}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`More actions for ${name}`}
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-7 items-center justify-center rounded-sm text-text-subtle hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-[210px] rounded-sm border border-border-soft bg-surface py-1 shadow-deep"
        >
          {removable ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onRemove(account);
              }}
              className="flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left font-sans text-[12px] text-health-error hover:bg-surface-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset"
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" />
              Remove account
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              aria-disabled="true"
              onClick={(event) => event.preventDefault()}
              className="flex min-h-[52px] w-full cursor-not-allowed items-start gap-2.5 px-3 py-2 font-sans text-[12px] text-text-subtle opacity-60"
            >
              <Trash2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="flex min-w-0 flex-col">
                <span>Remove account</span>
                <span className="mt-0.5 text-[10px] leading-tight">{unavailableReason}</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
