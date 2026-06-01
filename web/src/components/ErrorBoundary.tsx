import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

import { reportClientError } from '@/lib/client-error-report';

interface Props {
  children: ReactNode;
  /** Optional fallback to render instead of the default error UI. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors in the subtree and displays a recovery UI
 * rather than crashing the whole app to a blank screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console so it's still findable in DevTools.
    console.error('[ErrorBoundary]', error, info.componentStack);
    // Report to the operator's local client-error log (best-effort, local-only).
    reportClientError({
      kind: 'render',
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    const { children, fallback } = this.props;
    if (!error) return children;
    if (fallback) return fallback(error, this.reset);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <AlertCircle className="h-8 w-8 text-health-error" aria-hidden />
        <div>
          <div className="font-serif text-[16px] font-semibold text-text">Something went wrong</div>
          <div className="mt-1 font-mono text-[12px] text-text-muted">{error.message}</div>
        </div>
        <button
          onClick={this.reset}
          className="rounded-sm border border-border-soft bg-surface px-4 py-2 font-sans text-[13px] text-text hover:bg-surface-elevated"
        >
          Try again
        </button>
      </div>
    );
  }
}
