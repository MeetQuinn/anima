import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addKb } from '@/api/kb';
import { Button } from '@/components/ui/button';
import DirectoryPicker from '@/components/DirectoryPicker';
import { slugify, basename } from './utils';
import type { KbView } from '@shared/kb';

// ---------------------------------------------------------------------------
// Add Knowledge Base modal
// ---------------------------------------------------------------------------
export function AddKbModal({
  teamId,
  onClose,
  onAdded,
}: {
  // The team this KB is created under — the current working team in the sidebar.
  teamId: string;
  onClose: () => void;
  onAdded: (newId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  async function handleSelect(path: string) {
    const label = basename(path);
    const id = slugify(label);
    setBusy(true);
    setError(null);
    try {
      await addKb({ id, label, path, teamId });
      onAdded(id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-2xl rounded-sm border border-border-soft bg-surface p-5 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 font-serif text-[17px] font-semibold text-text">Add Knowledge Base</div>
        <DirectoryPicker
          onChoose={handleSelect}
          onCancel={onClose}
          confirmLabel={busy ? 'Adding…' : 'Add Knowledge Base'}
          confirmDisabled={busy}
        />
        {error && (
          <div className="mt-2 font-sans text-[12px] leading-snug text-health-error">{error}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Rename Knowledge Base modal
// ---------------------------------------------------------------------------
export function RenameKbModal({
  kb,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  kb: KbView;
  busy: boolean;
  error: string | null;
  onConfirm: (newLabel: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(kb.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onCancel();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-sm rounded-sm border border-border-soft bg-surface p-6 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-serif text-[17px] font-semibold text-text">Rename Knowledge Base</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) onConfirm(label.trim());
          }}
          className="mt-3 space-y-3"
        >
          <input
            ref={inputRef}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
            className="w-full rounded-sm border border-border bg-muted/30 px-3 py-1.5 font-sans text-[14px] text-text placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {error && (
            <div className="font-sans text-[12px] leading-snug text-health-error">{error}</div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onCancel} variant="outline" disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !label.trim() || label.trim() === kb.label}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Confirm delete modal
// ---------------------------------------------------------------------------
export function ConfirmDeleteModal({
  kb,
  busy,
  onConfirm,
  onCancel,
}: {
  kb: KbView;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onCancel();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-sm rounded-sm border border-health-error/30 bg-surface p-6 pl-8 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <span aria-hidden className="absolute left-0 top-4 bottom-4 w-px bg-health-error/50" />
        <div className="font-serif text-[17px] font-semibold text-text">Remove Knowledge Base?</div>
        <div className="font-serif mt-2 text-[14px] leading-relaxed text-text-muted">
          <span className="font-semibold text-text">{kb.label}</span> will be removed from
          the sidebar. Files on disk are not affected.
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onCancel} variant="outline" disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} variant="destructive" disabled={busy}>
            {busy ? 'Removing…' : 'Remove'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Kb kebab dropdown
// ---------------------------------------------------------------------------
export function KebabDropdown({
  anchorRect,
  onRename,
  onDelete,
  onClose,
}: {
  anchorRect: DOMRect;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed z-40 min-w-[128px] rounded-sm border border-border bg-surface py-0.5 shadow-md"
      style={{
        top: anchorRect.bottom + 4,
        right: window.innerWidth - anchorRect.right,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        onClick={onRename}
        className="flex w-full items-center px-3 py-1.5 font-sans text-[13px] text-text hover:bg-muted"
      >
        Rename
      </button>
      <button
        onClick={onDelete}
        className="flex w-full items-center px-3 py-1.5 font-sans text-[13px] text-health-error hover:bg-muted"
      >
        Delete
      </button>
    </div>,
    document.body,
  );
}

