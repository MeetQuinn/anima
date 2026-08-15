import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';

// Shared full-height error fallback for ErrorBoundary (render errors) and
// RouteErrorBoundary (route/chunk-load errors). The two boundaries had
// copy-pasted this markup; only the recovery button differs, so the action is
// caller-owned ("Try again" resets the boundary, "Reload" reloads the page).
export function ErrorFallback({ message, action }: { message: string; action: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertCircle className="h-8 w-8 text-health-error" aria-hidden />
      <div>
        <div className="font-serif text-[16px] font-semibold text-text">Something went wrong</div>
        <div className="mt-1 font-mono text-[12px] text-text-muted">{message}</div>
      </div>
      {action}
    </div>
  );
}

// The recovery button both callers share (flex/gap are inert without an icon).
export function ErrorFallbackButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-sm border border-border-soft bg-surface px-4 py-2 font-sans text-[13px] text-text hover:bg-surface-elevated"
    >
      {children}
    </button>
  );
}
