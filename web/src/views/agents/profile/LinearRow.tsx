import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Settings2, X } from 'lucide-react';
import { fetchLinearStatus, installLinear, removeLinear } from '@/api/linear';
import { refreshAgentData } from '@/api/agents';
import { Button } from '@/components/ui/button';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { Field } from './Primitives';

const listenerFailures = {
  address_in_use: 'The port is already in use. Free it or choose a different listener port.',
  permission_denied:
    'Permission to bind was denied. Check the listener address and port permissions.',
  address_unavailable: 'The bind address is unavailable. Check that it belongs to this machine.',
  other: 'The listener could not bind. Check the runtime logs and listener settings.',
};

export function LinearRow({ agentId }: { agentId: string }) {
  const status = useQuery({
    queryKey: ['agent', agentId, 'linear'],
    queryFn: () => fetchLinearStatus(agentId),
    refetchInterval: 5000,
    retry: false,
  });
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [callback, setCallback] = useState(`${window.location.origin}/api/linear/oauth/callback`);
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('14185');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const authorizationLink = useRef<HTMLAnchorElement>(null);
  const data = status.data;
  useEffect(() => {
    if (open && authorizationUrl && !busy) authorizationLink.current?.focus();
  }, [open, authorizationUrl, busy]);
  useEffect(() => {
    if (data?.state === 'connected' || data?.state === 'revoked') refreshAgentData(agentId);
  }, [data?.state, agentId]);
  const connected = data?.state === 'connected';
  const configured = Boolean(data && data.state !== 'not_configured');
  const listener = data?.listenerStatus;
  const listenerLabel =
    listener?.state === 'listening'
      ? 'Listening locally'
      : listener?.state === 'failed'
        ? 'Bind failed'
        : listener?.state === 'stopped'
          ? 'Stopped'
          : 'Not observed';

  async function install(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setAuthorizationUrl('');
    try {
      const result = await installLinear(agentId, {
        clientId,
        signingSecret: secret,
        callbackUrl: callback,
        listener: {
          host: data?.listener?.host ?? host,
          port: data?.listener?.port ?? Number(port),
        },
      });
      setSecret('');
      setAuthorizationUrl(result.authorizationUrl);
      await status.refetch();
    } catch {
      setError(
        'Installation could not start. Check the client ID, callback URL, signing secret and listener settings.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await removeLinear(agentId);
      setAuthorizationUrl('');
      setSecret('');
      await status.refetch();
      refreshAgentData(agentId);
    } catch {
      setError('Removal failed. Refresh the settings before trying again.');
    } finally {
      setBusy(false);
    }
  }
  const close = useCallback(() => {
    if (busy) return;
    setSecret('');
    setError('');
    setOpen(false);
  }, [busy]);
  const identityLabel = connected
    ? 'App installed'
    : data?.state === 'revoked'
      ? 'Authorization revoked'
      : data?.state === 'installing'
        ? 'Awaiting authorization'
        : 'Not connected';
  const inputClass =
    'h-[44px] w-full min-w-0 rounded-sm border border-border-soft bg-surface px-3 font-mono text-[13px] text-text outline-none focus-visible:border-accent';

  return (
    <>
      <Field label="Linear">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <p className={`break-words ${configured ? 'font-serif text-[15px] text-text' : 'font-sans text-[13px] text-text-muted'}`}>
              {data?.workspaceName ?? (status.isPending ? 'Loading…' : !data ? 'Unknown' : connected ? 'Workspace name unavailable' : 'Not connected')}
            </p>
            {(status.isError || data?.state === 'revoked' || data?.state === 'installing' || listener?.state === 'failed' || data?.lastError) && (
              <p className="mt-0.5 font-sans text-[12px] text-health-error">
                {status.isError ? 'Settings unavailable' : data?.state === 'revoked' ? 'Authorization revoked'
                  : listener?.state === 'failed' ? 'Local listener failed'
                    : data?.state === 'installing' ? 'Awaiting authorization' : 'Needs attention'}
              </p>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              className="flex h-[44px] w-[44px] items-center justify-center rounded-sm text-text-subtle opacity-40 transition-all hover:bg-surface-elevated hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-accent md:h-7 md:w-7"
              aria-label="Configure Linear"
              title="Configure Linear"
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </Field>
      {open && (
        <LinearSettingsDialog busy={busy} onClose={close}>
          {configured && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-serif text-[15px] text-text">{identityLabel}</p>
              <Button
                variant="outline"
                className="min-h-[44px]"
                onClick={() => void remove()}
                disabled={busy}
              >
                {busy ? 'Removing…' : 'Remove connection'}
              </Button>
            </div>
          )}
          {configured && listener?.state === 'failed' && (
            <div
              role="alert"
              className="mt-3 rounded-sm border border-health-error/30 bg-health-error/5 px-3 py-3 font-sans text-[13px] leading-relaxed text-health-error"
            >
              <p className="font-medium">Local webhook listener failed</p>
              <p>{listenerFailures[listener.reason ?? 'other']}</p>
            </div>
          )}
          {status.isPending && (
            <p role="status" className="mt-3 font-sans text-[13px] text-text-muted">
              Loading Linear settings…
            </p>
          )}
          {status.isError && (
            <p role="alert" className="mt-3 font-sans text-[13px] text-health-error">
              Linear settings could not be read.{' '}
              <button
                type="button"
                className="inline-flex min-h-[44px] items-center px-2 underline md:min-h-[32px]"
                onClick={() => void status.refetch()}
              >
                Retry
              </button>
            </p>
          )}
          {data && configured && (
            <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-border-soft pt-4 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="chrome text-[11px] text-text-muted">Client ID</dt>
                <dd className="mt-1 break-all font-mono text-[12px] text-text">{data.clientId}</dd>
              </div>
              <div>
                <dt className="chrome text-[11px] text-text-muted">Last signed webhook received</dt>
                <dd className="mt-1 font-sans text-[13px] text-text">
                  {data.lastSignedWebhookAt
                    ? new Date(data.lastSignedWebhookAt).toLocaleString()
                    : 'None received'}
                </dd>
              </div>
              <div>
                <dt className="chrome text-[11px] text-text-muted">Rejected signature claims</dt>
                <dd className="mt-1 font-sans text-[13px] text-text">{data.signatureFailures}</dd>
              </div>
              <div className="min-w-0">
                <dt className="chrome text-[11px] text-text-muted">Configured listener address</dt>
                <dd className="mt-1 break-all font-mono text-[12px] text-text">
                  {data.listener
                    ? `${data.listener.host}:${data.listener.port}/webhook`
                    : 'Not configured'}
                </dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="chrome text-[11px] text-text-muted">Local listener</dt>
                <dd
                  className={`mt-1 font-sans text-[13px] ${listener?.state === 'failed' ? 'text-health-error' : 'text-text'}`}
                >
                  {listenerLabel}
                  {listener?.observedAt && (
                    <span className="ml-2 text-text-muted">
                      Observed {new Date(listener.observedAt).toLocaleString()}
                    </span>
                  )}
                </dd>
                <dd className="mt-1 font-sans text-[12px] leading-relaxed text-text-muted">
                  {listener?.state === 'unknown' || !listener
                    ? 'No current observation from the runtime. '
                    : ''}
                  This shared local listener state does not verify your public HTTPS ingress.
                </dd>
              </div>
            </dl>
          )}
          {data?.lastError && (
            <p role="alert" className="mt-3 font-sans text-[13px] text-health-error">
              {data.lastError}
            </p>
          )}
          {data?.signatureFailures ? (
            <p className="mt-3 font-sans text-[13px] text-health-warn">
              Requests claiming this app failed signature verification. Counts are saved at most
              once a minute and when the listener stops; a crash can lose unsaved counts. This is
              not a connection health check.
            </p>
          ) : null}
          {data && !configured && (
            <form onSubmit={(event) => void install(event)} className="space-y-4">
              <p className="font-sans text-[13px] leading-relaxed text-text-muted">
                Create a separate OAuth app for this agent in{' '}
                <a
                  href="https://linear.app/settings/api/applications"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline"
                >
                  Linear settings
                </a>
                . Select Agent session events, register the callback below, and expose the local
                webhook through your own HTTPS ingress.
              </p>
              <label className="block">
                <span className="mb-1 block font-sans text-[12px] text-text-muted">Client ID</span>
                <input
                  required
                  disabled={busy}
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className={inputClass}
                  autoComplete="off"
                />
              </label>
              <label className="block">
                <span className="mb-1 block font-sans text-[12px] text-text-muted">
                  Webhook signing secret
                </span>
                <input
                  type="password"
                  required
                  disabled={busy}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  className={inputClass}
                  autoComplete="new-password"
                />
              </label>
              <label className="block">
                <span className="mb-1 block font-sans text-[12px] text-text-muted">
                  OAuth callback URL
                </span>
                <input
                  type="url"
                  required
                  disabled={busy}
                  value={callback}
                  onChange={(e) => setCallback(e.target.value)}
                  className={inputClass}
                />
              </label>
              <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
                <label>
                  <span className="mb-1 block font-sans text-[12px] text-text-muted">
                    Bind address
                  </span>
                  <input
                    required
                    value={data?.listener?.host ?? host}
                    disabled={busy || Boolean(data?.listener)}
                    onChange={(e) => setHost(e.target.value)}
                    className={inputClass}
                  />
                </label>
                <label>
                  <span className="mb-1 block font-sans text-[12px] text-text-muted">Port</span>
                  <input
                    type="number"
                    required
                    min="1024"
                    max="65535"
                    value={data?.listener?.port ?? port}
                    disabled={busy || Boolean(data?.listener)}
                    onChange={(e) => setPort(e.target.value)}
                    className={inputClass}
                  />
                </label>
              </div>
              <p className="font-sans text-[12px] leading-relaxed text-text-muted">
                Loopback is the default. All agents share this listener. It serves only signed
                webhooks at /webhook; the dashboard handles OAuth separately. Secrets stay in
                runtime storage and are never shown back.
              </p>
              <Button type="submit" className="min-h-[44px]" disabled={busy || status.isError}>
                {busy ? 'Preparing…' : 'Prepare authorization'}
              </Button>
            </form>
          )}
          {authorizationUrl && !connected && (
            <a
              ref={authorizationLink}
              href={authorizationUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-sm border border-accent px-4 font-sans text-[13px] text-accent"
            >
              Authorize in Linear <ExternalLink className="size-3.5" />
            </a>
          )}
          {error && (
            <p role="alert" className="mt-3 font-sans text-[13px] text-health-error">
              {error}
            </p>
          )}
          {data && (
            <p className="mt-4 font-sans text-[12px] leading-relaxed text-text-muted">
              Received requests persist locally. Requests never received during downtime are not
              recovered after Linear's retry window or disabled delivery. Restore delivery, check
              progress, then send a new prompt. Removing this connection does not uninstall the app
              from Linear.
            </p>
          )}
        </LinearSettingsDialog>
      )}
    </>
  );
}

function LinearSettingsDialog({
  busy,
  onClose,
  children,
}: {
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { dialogRef, titleId, isTopmostDialog } = useDialogFocus(true);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && isTopmostDialog()) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isTopmostDialog]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-page/70 backdrop-blur-sm md:items-center md:p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-full w-full flex-col border-border bg-surface shadow-deep md:h-auto md:max-h-[85dvh] md:max-w-xl md:rounded-sm md:border"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border-soft px-5 py-3">
          <h2 id={titleId} className="font-serif text-[17px] font-semibold text-text">
            Linear
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close Linear settings"
            className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-elevated hover:text-text disabled:opacity-40 md:h-8 md:w-8"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
