import { Copy, ExternalLink } from 'lucide-react';

import type { ProviderLoginMode, ProviderLoginRow } from '@shared/provider-login';

// Sign-in block for one provider. Anima only relays what the provider CLI
// prints: a link (browser flow, completes on this machine) or a link plus a
// one-time code (device flow, completes on any device). The credential itself
// never passes through the dashboard.
export function ProviderSignIn({
  busy = false,
  error,
  label,
  login,
  onCancel,
  onStart,
}: {
  busy?: boolean;
  error?: string;
  label: string;
  login: ProviderLoginRow;
  onCancel: () => void;
  onStart: (mode: ProviderLoginMode) => void;
}) {
  const operation = login.operation;
  const running = operation.status === 'running';
  const stateLabel =
    login.state === 'signed_in' ? 'Signed in' : login.state === 'signed_out' ? 'Not signed in' : 'Sign-in state unknown';
  const stateTone =
    login.state === 'signed_in' ? 'text-text' : login.state === 'signed_out' ? 'text-health-warn' : 'text-text-muted';
  const expires = operation.expiresAt ? new Date(operation.expiresAt) : undefined;

  return (
    <div className="space-y-1.5" data-testid={`provider-sign-in-${login.provider}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-text-subtle">Sign-in</span>
        <span className={`font-sans text-[12px] ${stateTone}`}>{stateLabel}</span>
        {login.detail && login.state !== 'signed_out' && (
          <span className="min-w-0 truncate font-mono text-[10px] text-text-subtle" title={login.detail}>
            {login.detail}
          </span>
        )}
      </div>

      {running ? (
        <div className="space-y-2 rounded-sm border border-border-soft bg-surface-elevated px-3 py-2.5">
          <p className="font-sans text-[11px] leading-relaxed text-text-muted">
            {operation.mode === 'device'
              ? 'Open the link on any device, enter the code, and sign in to the provider account.'
              : 'Finish the sign-in in the browser on this machine. The provider returns to Anima when it is done.'}
          </p>
          {operation.url ? (
            <a
              className="inline-flex min-h-[36px] items-center gap-1.5 font-mono text-[11px] text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              href={operation.url}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="break-all">{operation.url}</span>
            </a>
          ) : (
            <p className="font-sans text-[11px] text-text-subtle">Waiting for the provider to print the sign-in link…</p>
          )}
          {operation.mode === 'device' && operation.code && (
            <div className="flex flex-wrap items-center gap-2">
              <code
                aria-label={`${label} one-time code`}
                className="rounded-sm bg-surface px-2.5 py-1.5 font-mono text-[18px] font-semibold tracking-[0.12em] text-text"
              >
                {operation.code}
              </code>
              <button
                type="button"
                className="flex min-h-[36px] items-center gap-1 rounded-sm border border-border-soft px-2.5 font-sans text-[11px] text-text-muted hover:border-border hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                onClick={() => {
                  if (operation.code) void navigator.clipboard.writeText(operation.code);
                }}
                title="Copy code"
              >
                <Copy className="h-3 w-3" />
                Copy
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-sans text-[10px] text-text-subtle">
              {expires ? `Link expires at ${expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
            </span>
            <button
              type="button"
              className="min-h-[36px] rounded-sm border border-border-soft px-3 font-sans text-[11px] font-medium text-text-muted hover:border-border hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel sign-in
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="min-h-[36px] rounded-sm border border-border-soft px-3 font-sans text-[11px] font-medium text-text-muted hover:border-border hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy}
            onClick={() => onStart('browser')}
            title={`Runs \`${login.command} login\` on this machine and opens the provider sign-in page here`}
          >
            Sign in in this browser
          </button>
          <button
            type="button"
            className="min-h-[36px] rounded-sm border border-border-soft px-3 font-sans text-[11px] font-medium text-text-muted hover:border-border hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy}
            onClick={() => onStart('device')}
            title={`Runs \`${login.command} login --device-auth\`; finish on any device with a one-time code`}
          >
            Sign in with a code
          </button>
        </div>
      )}

      {operation.status === 'failed' && operation.error && (
        <p className="font-sans text-[10px] leading-relaxed text-health-error">{operation.error}</p>
      )}
      {operation.status === 'cancelled' && !error && (
        <p className="font-sans text-[10px] leading-relaxed text-text-subtle">Sign-in cancelled.</p>
      )}
      {error && <p className="font-sans text-[10px] leading-relaxed text-health-error">{error}</p>}
      <p className="font-sans text-[10px] leading-relaxed text-text-subtle">
        Runs <code className="font-mono">{login.command} login</code> as this machine user. The provider stores the
        credential; every agent using {label} on this machine shares it.
      </p>
    </div>
  );
}
