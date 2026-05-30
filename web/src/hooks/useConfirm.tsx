import { useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import ConfirmModal from '@/components/ConfirmModal';

export interface ConfirmOptions {
  title: string;
  description: ReactNode;
  variant?: 'error' | 'warn';
  size?: 'default' | 'large';
  confirmLabel?: string;
  busyLabel?: string;
  confirmVariant?: 'destructive' | 'default';
  onConfirm: () => Promise<void>;
}

interface ConfirmState extends Omit<ConfirmOptions, 'onConfirm'> {
  open: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => Promise<void>;
}

/**
 * Lightweight imperative confirm wrapper over the existing ConfirmModal shell.
 *
 * Usage:
 *   const { confirm, modal } = useConfirm();
 *
 *   // in JSX
 *   {modal}
 *
 *   // in handler
 *   confirm({
 *     title: 'Disable this agent?',
 *     description: '...',
 *     onConfirm: async () => { await disableAgent(id); },
 *   });
 *
 * The hook manages open/busy/error state internally. onConfirm success closes
 * the modal; onConfirm failure shows the error and keeps the modal open for
 * retry. The caller only provides the async action.
 */
export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    setState({
      ...options,
      open: true,
      busy: false,
      error: null,
      onConfirm: options.onConfirm,
    });
  }, []);

  const close = useCallback(() => {
    setState(null);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!state) return;
    setState((prev) => (prev ? { ...prev, busy: true, error: null } : null));
    try {
      await state.onConfirm();
      setState(null);
    } catch (err) {
      setState((prev) =>
        prev
          ? { ...prev, busy: false, error: err instanceof Error ? err.message : String(err) }
          : null,
      );
    }
  }, [state]);

  const modal = state ? (
    <ConfirmModal
      open={state.open}
      title={state.title}
      description={state.description}
      variant={state.variant}
      size={state.size}
      busy={state.busy}
      error={state.error}
      confirmLabel={state.confirmLabel}
      busyLabel={state.busyLabel}
      confirmVariant={state.confirmVariant}
      onConfirm={handleConfirm}
      onCancel={close}
    />
  ) : null;

  return { confirm, close, modal };
}
