import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, ExternalLink, Loader2, RefreshCw } from 'lucide-react';

import type {
  ClaudeAccountLoginOperation,
  ProviderAccountSummary,
} from '@shared/provider-accounts';
import {
  cancelClaudeAccountLogin,
  fetchClaudeAccountLogin,
  startClaudeAccountLogin,
  submitClaudeAccountLoginCode,
} from '@/api/system';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Props {
  account?: ProviderAccountSummary;
  onClose: () => void;
  onSucceeded: () => void;
}

export default function ClaudeAccountLoginModal({ account, onClose, onSucceeded }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const started = useRef(false);
  const reportedSuccess = useRef(false);
  const [operation, setOperation] = useState<ClaudeAccountLoginOperation>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const operationId = operation?.id;
  const operationStatus = operation?.status;

  const begin = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setOperation(undefined);
    setCode('');
    reportedSuccess.current = false;
    try {
      setOperation(await startClaudeAccountLogin(account ? { accountId: account.id } : {}));
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(false);
    }
  }, [account]);

  const close = useCallback(async (): Promise<void> => {
    if (busy || closing.current) return;
    if (operation && !terminal(operation.status)) {
      closing.current = true;
      setBusy(true);
      setError(undefined);
      try {
        await cancelClaudeAccountLogin(operation.id);
      } catch {
        setError('Could not cancel sign-in. Try again.');
        setBusy(false);
        closing.current = false;
        return;
      }
      setBusy(false);
      closing.current = false;
    }
    onClose();
  }, [busy, onClose, operation]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    dialogRef.current?.focus();
    void begin();
  }, [begin]);

  useEffect(() => {
    if (!operationId || (operationStatus && terminal(operationStatus))) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      let next: ClaudeAccountLoginOperation | undefined;
      try {
        next = await fetchClaudeAccountLogin(operationId);
        if (disposed) return;
        setOperation(next);
        setError(undefined);
      } catch {
        if (disposed) return;
        setError('Could not refresh sign-in status. Retrying…');
      }
      if (!disposed && (!next || !terminal(next.status))) {
        timer = window.setTimeout(() => void poll(), 750);
      }
    };
    timer = window.setTimeout(() => void poll(), 750);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [operationId, operationStatus]);

  useEffect(() => {
    if (operation?.status !== 'succeeded' || reportedSuccess.current) return;
    reportedSuccess.current = true;
    onSucceeded();
  }, [onSucceeded, operation?.status]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) void close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, close]);

  async function submitCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!operation || !code.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setOperation(await submitClaudeAccountLoginCode(operation.id, code));
      setCode('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  }

  const waiting = !operation || operation.status === 'starting';
  const failed = operation?.status === 'failed' || Boolean(error && !operation);
  const succeeded = operation?.status === 'succeeded';
  const title = account
    ? `Sign in to ${account.account ?? account.label}`
    : 'Add Claude account';

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-page/75 px-4 backdrop-blur-sm"
      role="presentation"
      onClick={() => void close()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-sm border border-border-soft bg-surface p-6 shadow-deep"
        onClick={(event) => event.stopPropagation()}
      >
        <div id={titleId} className="break-words font-serif text-[17px] font-semibold text-text">{title}</div>

        {waiting && !failed && (
          <div className="mt-6 flex items-center gap-2 font-sans text-[12px] text-text-muted" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            Starting secure sign-in…
          </div>
        )}

        {operation && !succeeded && operation.status !== 'failed' && (
          <div className="mt-4 space-y-4">
            <p className="font-serif text-[14px] leading-relaxed text-text-muted">
              Complete sign-in with Anthropic. This account stays separate until you explicitly make it active.
            </p>
            {operation.loginUrl ? (
              <Button
                nativeButton={false}
                render={<a href={operation.loginUrl} rel="noreferrer" target="_blank" />}
                className="min-h-[44px] w-full"
              >
                <ExternalLink className="h-4 w-4" />
                Continue in browser
              </Button>
            ) : (
              <div className="flex items-center gap-2 font-sans text-[12px] text-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Waiting for Claude…
              </div>
            )}
            <form className="space-y-2" onSubmit={(event) => void submitCode(event)}>
              <label htmlFor="claude-login-code" className="font-sans text-[11px] font-medium text-text-muted">
                One-time code
              </label>
              <div className="flex gap-2">
                <Input
                  id="claude-login-code"
                  value={code}
                  onChange={(event) => setCode(event.currentTarget.value)}
                  autoComplete="one-time-code"
                  disabled={busy}
                  placeholder="Paste code"
                  className="h-10 min-w-0 font-mono text-[13px]"
                />
                <Button type="submit" size="sm" disabled={busy || !code.trim()} className="min-h-[40px]">
                  Verify
                </Button>
              </div>
              <p className="font-sans text-[10px] leading-relaxed text-text-subtle">
                Only needed when the browser shows a code instead of finishing automatically.
              </p>
            </form>
          </div>
        )}

        {succeeded && (
          <div className="mt-5 space-y-2" role="status">
            <div className="flex items-center gap-2 font-sans text-[13px] font-medium text-health-ok">
              <Check className="h-4 w-4" />
              Signed in{operation.account ? ` as ${operation.account}` : ''}
            </div>
            <p className="font-serif text-[13px] leading-relaxed text-text-muted">
              The account is ready. Your active account has not changed.
            </p>
          </div>
        )}

        {(operation?.status === 'failed' || error) && (
          <div className="mt-4 space-y-3">
            <p className="font-sans text-[11px] leading-relaxed text-health-error" role="alert">
              {operation?.error ?? error ?? 'Claude sign-in failed.'}
            </p>
            {(operation?.status === 'failed' || !operation) && (
              <Button type="button" variant="outline" size="sm" onClick={() => void begin()} disabled={busy}>
                <RefreshCw className="h-3.5 w-3.5" />
                Try again
              </Button>
            )}
          </div>
        )}

        <div className="mt-6 flex justify-end">
          <Button type="button" variant={succeeded ? 'default' : 'outline'} size="sm" onClick={() => void close()} disabled={busy} className="min-h-[44px]">
            {succeeded ? 'Done' : 'Cancel'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function terminal(status: ClaudeAccountLoginOperation['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
