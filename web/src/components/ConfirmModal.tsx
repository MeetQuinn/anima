import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui/button';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: ReactNode;
  variant?: 'error' | 'warn';
  size?: 'default' | 'large';
  busy?: boolean;
  error?: string | null;
  confirmLabel?: string;
  busyLabel?: string;
  confirmVariant?: 'destructive' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shared confirm overlay — fixed backdrop, Esc/click-outside to cancel,
 * accent rule, title + description + optional error, Confirm/Cancel buttons.
 *
 * Default size is a compact modal (max-w-md) for per-agent actions.
 * Large size (max-w-xl) is for global decisions like service restart.
 */
export default function ConfirmModal({
  open,
  title,
  description,
  variant = 'error',
  size = 'default',
  busy = false,
  error,
  confirmLabel = 'Confirm',
  busyLabel = 'Saving…',
  confirmVariant = 'destructive',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const palette =
    variant === 'error'
      ? { border: 'border-health-error/40', bg: 'bg-health-error-soft', rule: 'bg-health-error' }
      : { border: 'border-health-warn/40', bg: 'bg-health-warn-soft', rule: 'bg-health-warn' };

  const isLarge = size === 'large';


  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-page/70 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onCancel();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className={[
          'relative w-full rounded-sm border shadow-deep',
          palette.border,
          palette.bg,
          isLarge ? 'max-w-xl p-7 pl-8' : 'mx-4 max-w-md p-6 pl-7',
        ].join(' ')}
        onClick={(e) => e.stopPropagation()}
      >
        <span
          aria-hidden
          className={`absolute left-0 top-4 bottom-4 w-px ${palette.rule}`}
        />
        <div
          className={[
            'font-serif font-semibold text-text',
            isLarge ? 'text-[17px]' : 'text-[16px]',
          ].join(' ')}
        >
          {title}
        </div>
        <div
          className={[
            'font-serif mt-2 leading-relaxed text-text-muted',
            isLarge ? 'text-[15px]' : 'text-[14px]',
          ].join(' ')}
        >
          {description}
        </div>
        {error && (
          <div className="mt-2 font-sans text-[11px] tracking-wide text-health-error">
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            disabled={busy}
            onClick={onCancel}
            variant="outline"
            className={isLarge ? undefined : 'min-h-[44px]'}
            size={isLarge ? undefined : 'sm'}
          >
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={onConfirm}
            variant={confirmVariant}
            className={isLarge ? undefined : 'min-h-[44px]'}
            size={isLarge ? undefined : 'sm'}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
