import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle, Check, X } from 'lucide-react';
import {
  fetchLinearSetup,
  fetchLinearStatus,
  linearSetupKey,
  installLinear,
  openLinearAuthorization,
  removeLinear,
  saveLinearClientSecret,
} from '@/api/linear';
import { refreshAgentData } from '@/api/agents';
import { Button } from '@/components/ui/button';
import { PublicAddressCheck, PublicAddressForm, PublicAddressGuidance } from '@/components/PublicUrlSettings';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { useNow } from '@/hooks/useNow';
import { formatRelativeShort, shortIso } from '@/lib/format';
import { Field } from './Primitives';
import { LinearClientSecretRequest, type LinearClientSecretResult, type LinearInstallRequest, type LinearStatus } from '@shared/linear';
import { inputClass, LinearConnectSteps, notACredentialField } from './LinearConnectSteps';

// The receiver's address is a config.json setting (linearWebhook), not a dashboard one.
const listenerFailures = {
  address_in_use: 'Its local port is already in use. Free it, or set another port in linearWebhook in config.json.',
  permission_denied: 'Permission to bind its local port was denied. Check linearWebhook in config.json.',
  address_unavailable: 'Its local address is unavailable. Check that linearWebhook in config.json names this machine.',
  other: 'Its local receiver could not start. Check the runtime logs.',
};

// Only fixed installation reasons are safe to display; schema/storage errors
// can contain user input or local paths.
const knownInstallErrors = new Set([
  'Set the Anima public URL in Server settings and refresh the connection form.',
  'Use a separate Linear app for each agent.',
  'Remove the installed identity before replacing it.',
]);

type Notice = { title: string; body?: string };

// Server failure reasons in plain words. Exchange and verification failures
// carry a short technical reason in parentheses; keep it as a detail.
function failureNotice(lastError: string): Notice {
  const detail = /\(([^)]{1,60})\)/.exec(lastError)?.[1];
  const withDetail = (body: string) => (detail ? `${body} Details: ${detail}.` : body);
  if (lastError.startsWith('Linear authorization was declined'))
    return { title: 'Authorization was declined in Linear', body: 'Authorize again whenever you’re ready.' };
  if (lastError.startsWith('Linear authorization could not be exchanged'))
    return {
      title: 'Authorization couldn’t be completed',
      body: withDetail(
        detail?.endsWith('invalid_client')
          ? 'Linear didn’t accept the Client ID and Client secret. Copy both again from the app’s page in Linear, then authorize again.'
          : 'Check the Client ID and Client secret, that the app’s callback URL in Linear uses your public address, and this machine’s network. Then authorize again.',
      ),
    };
  if (lastError.startsWith('Linear app identity could not be verified'))
    return {
      title: 'Anima couldn’t verify the app',
      body: withDetail('Check the app’s settings in Linear and this machine’s network, then authorize again.'),
    };
  return { title: 'Authorization didn’t finish', body: lastError };
}

function unansweredTitle(count: number): string {
  return count === 1 ? '1 session ended without a reply' : `${count} sessions ended without a reply`;
}

function noticeFor(data: LinearStatus | undefined): Notice | null {
  if (!data) return null;
  if (data.state === 'revoked')
    return { title: 'Linear access was revoked', body: 'Authorize again with your existing app to reconnect.' };
  if (data.state === 'installing')
    return { title: 'Authorization wasn’t finished', body: 'Authorize again with your existing app.' };
  if (data.state === 'not_configured' && data.clientId)
    return { title: 'The last authorization expired', body: 'Authorize again with your existing app.' };
  if (data.state === 'not_configured' && data.lastError) return failureNotice(data.lastError);
  return null;
}

export function LinearRow({
  agentId,
  agentName = agentId,
  avatarUrl,
  initialOpen = false,
}: {
  agentId: string;
  agentName?: string;
  /** Prefilled as the new app's icon when it is a public image. */
  avatarUrl?: string;
  /** Open the dialog on mount, e.g. when returning from Linear's authorization page. */
  initialOpen?: boolean;
}) {
  const status = useQuery({
    queryKey: ['agent', agentId, 'linear'],
    queryFn: () => fetchLinearStatus(agentId),
    refetchInterval: 5000,
    retry: false,
  });
  const [open, setOpen] = useState(initialOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const data = status.data;
  const connected = data?.state === 'connected';
  const notice = noticeFor(data);
  const clientRejected = connected && Boolean(data.clientRejected);
  const unanswered = connected ? (data.unansweredSessions ?? 0) : 0;
  const attention =
    status.isError ||
    data?.state === 'revoked' ||
    data?.listenerStatus?.state === 'failed' ||
    clientRejected ||
    Boolean(notice && !connected);

  useEffect(() => {
    if (data?.state === 'connected' || data?.state === 'revoked') refreshAgentData(agentId);
  }, [data?.state, agentId]);
  useEffect(() => {
    // Back from Linear can restore this page from the back/forward cache with
    // "Opening Linear…" frozen in place; let the user act again.
    function onShow(event: PageTransitionEvent) {
      if (event.persisted) setBusy(false);
    }
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  async function install(input: LinearInstallRequest) {
    setBusy(true);
    setError('');
    try {
      const result = await installLinear(agentId, input);
      // Same tab: Linear returns through Anima's completion page to this profile.
      openLinearAuthorization(result.authorizationUrl);
    } catch (err) {
      setError(
        err instanceof Error && knownInstallErrors.has(err.message)
          ? err.message
          : 'Authorization could not start. Check the Client ID, Client secret and Webhook signing secret. If the public address changed, refresh this form.',
      );
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await removeLinear(agentId);
      await status.refetch();
      refreshAgentData(agentId);
    } catch {
      setError('Could not disconnect. Refresh the page and try again.');
    } finally {
      setBusy(false);
    }
  }
  const close = useCallback(() => {
    if (busy) return;
    setError('');
    setOpen(false);
  }, [busy]);

  const rowAction = connected ? 'Manage' : attention && data ? 'Review' : 'Connect';
  return (
    <>
      <Field label="Linear">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            {connected ? (
              <p className="flex min-w-0 items-center gap-2 font-serif text-[15px] text-text">
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-health-ok" />
                <span className="break-words">{data.workspaceName ?? 'Connected'}</span>
              </p>
            ) : (
              <p className="font-sans text-[13px] text-text-muted">
                {status.isPending ? 'Loading…' : status.isError && !data ? 'Unavailable' : 'Not connected'}
              </p>
            )}
            {attention && (
              <p className="mt-0.5 font-sans text-[12px] text-health-error">
                {status.isError
                  ? 'Status unavailable'
                  : data?.listenerStatus?.state === 'failed'
                    ? 'Not receiving events'
                    : clientRejected
                      ? 'Credentials not accepted'
                      : (notice?.title ?? 'Needs attention')}
              </p>
            )}
            {!attention && unanswered > 0 && (
              <p className="mt-0.5 font-sans text-[12px] text-health-warn-ink">{unansweredTitle(unanswered)}</p>
            )}
          </div>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`${rowAction} Linear`}
            onClick={() => setOpen(true)}
            className="ml-auto inline-flex min-h-11 shrink-0 items-center rounded-sm px-2.5 font-sans text-[12px] font-medium text-accent transition-colors hover:bg-surface-elevated hover:text-accent-hover focus-visible:outline focus-visible:outline-accent md:min-h-8"
          >
            {rowAction}
          </button>
        </div>
      </Field>
      {open && (
        <LinearDialog busy={busy} onClose={close}>
          <LinearDialogBody
            agentId={agentId}
            agentName={agentName}
            avatarUrl={avatarUrl}
            status={status}
            notice={notice}
            busy={busy}
            error={error}
            onInstall={install}
            onRemove={remove}
            onClose={close}
          />
        </LinearDialog>
      )}
    </>
  );
}

function LinearDialogBody({
  agentId,
  agentName,
  avatarUrl,
  status,
  notice,
  busy,
  error,
  onInstall,
  onRemove,
  onClose,
}: {
  agentId: string;
  agentName: string;
  avatarUrl?: string;
  status: UseQueryResult<LinearStatus>;
  notice: Notice | null;
  busy: boolean;
  error: string;
  onInstall: (input: LinearInstallRequest) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
}) {
  const setup = useQuery({ queryKey: linearSetupKey, queryFn: fetchLinearSetup, retry: false });
  const noticeRef = useRef<HTMLDivElement>(null);
  const data = status.data;
  // Move focus to a failure the moment it appears, so keyboard and screen
  // reader users land on the reason instead of a control that just unmounted.
  const noticeKey = notice ? `${notice.title}|${notice.body ?? ''}` : '';
  const noticeShown = Boolean(
    notice && data && data.state !== 'connected' && setup.data?.publicUrl && setup.data.callbackUrl,
  );
  useEffect(() => {
    if (!noticeKey || !noticeShown) return;
    // Deferred past the dialog's own initial focus, which runs after this
    // effect in the same commit when the dialog opens on a failure.
    const id = window.setTimeout(() => noticeRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [noticeKey, noticeShown]);

  if (status.isPending || (setup.isPending && data?.state !== 'connected'))
    return <Loading />;
  if (!data)
    return <ReadError what="Linear status" onRetry={() => void status.refetch()} />;
  if (data.state === 'connected')
    return (
      <ConnectedView
        agentId={agentId}
        agentName={agentName}
        data={data}
        busy={busy}
        error={error}
        onRemove={onRemove}
        onClose={onClose}
        onChanged={async () => (await status.refetch()).data}
      />
    );
  if (!setup.data) return <ReadError what="machine settings" onRetry={() => void setup.refetch()} />;
  if (!setup.data.publicUrl || !setup.data.callbackUrl)
    return <PublicAddressStep onSaved={() => void setup.refetch()} />;
  // A background refresh failed: keep what the user typed, but pause
  // authorizing until the state it would act on can be read again.
  const stale = status.isError ? 'Linear status' : setup.isError ? 'machine settings' : '';
  return (
    <div className="space-y-6">
      {stale && (
        <ReadError
          what={stale}
          refresh
          onRetry={() => void (status.isError ? status.refetch() : setup.refetch())}
        />
      )}
      {notice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role="alert"
          className="flex gap-3 rounded-sm border border-health-error/25 bg-health-error-soft/50 px-3.5 py-3 outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-health-error" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-sans text-[13px] font-medium text-health-error">{notice.title}</p>
            {notice.body && <p className="font-sans text-[12px] leading-relaxed text-text-muted">{notice.body}</p>}
          </div>
        </div>
      )}
      <LinearConnectSteps
        key={notice ? 'retry' : 'new'}
        agentName={agentName}
        avatarUrl={avatarUrl}
        setup={setup.data}
        busy={busy}
        disabled={Boolean(stale)}
        retrying={Boolean(notice)}
        error={error}
        onInstall={onInstall}
      />
      <p className="flex flex-wrap items-baseline gap-x-1.5 border-t border-border-soft pt-4 font-sans text-[12px] text-text-subtle">
        <span>Public address</span>
        <span className="break-all font-mono text-text-muted">{setup.data.publicUrl}</span>
        <a
          href="/settings/server#public-url"
          aria-label="Change public address"
          className="inline-flex min-h-11 items-center underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted md:min-h-0"
        >
          Change
        </a>
      </p>
      <PublicAddressCheck publicUrl={setup.data.publicUrl} />
      {data.state !== 'not_configured' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRemove()}
          className="inline-flex min-h-11 items-center font-sans text-[12px] text-text-subtle underline decoration-text-subtle/40 underline-offset-2 hover:text-health-error md:min-h-0"
        >
          Disconnect from Linear instead
        </button>
      )}
    </div>
  );
}

function PublicAddressStep({ onSaved }: { onSaved: () => void }) {
  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <p className="font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-text-subtle">One-time setup</p>
        <h3 className="font-serif text-[20px] font-semibold leading-tight text-text">Give Anima a public address</h3>
        <p className="font-serif text-[14px] leading-relaxed text-text-muted">
          Linear reaches your agents through an HTTPS address that forwards to this machine. Set it once and
          every agent uses it.
        </p>
      </header>
      <PublicAddressForm autoFocus onSaved={onSaved} />
      <PublicAddressGuidance />
      <p className="font-sans text-[12px] text-text-subtle">
        You can change it later in{' '}
        <a href="/settings/server#public-url" className="underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted">
          Settings → Server
        </a>
        .
      </p>
    </div>
  );
}

function ConnectedView({
  agentId,
  agentName,
  data,
  busy,
  error,
  onRemove,
  onClose,
  onChanged,
}: {
  agentId: string;
  agentName: string;
  data: LinearStatus;
  busy: boolean;
  error: string;
  onRemove: () => Promise<void>;
  onClose: () => void;
  onChanged: () => Promise<LinearStatus | undefined>;
}) {
  const [confirming, setConfirming] = useState(false);
  const now = useNow();
  const listener = data.listenerStatus;
  // Local receiver state only. The public address has its own check in Server
  // settings; "Last event" is the evidence that Linear reaches this machine.
  const events =
    listener?.state === 'listening'
      ? 'Listening'
      : listener?.state === 'failed'
        ? 'Failed'
        : listener?.state === 'stopped'
          ? 'Stopped'
          : 'Not observed yet';
  return (
    <div className="space-y-5">
      <header className="flex items-start gap-3.5">
        {data.clientRejected ? (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-health-error-soft text-health-error">
            <AlertTriangle className="size-5" aria-hidden="true" />
          </span>
        ) : (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-health-ok-soft text-health-ok">
            <Check className="size-5" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 space-y-1">
          <h3 className="break-words font-serif text-[20px] font-semibold leading-tight text-text">
            Connected to {data.workspaceName ?? 'Linear'}
          </h3>
          <p className="font-serif text-[14px] leading-relaxed text-text-muted">
            {data.clientRejected
              ? `${agentName} can’t work in Linear until Linear accepts this app’s credentials.`
              : `Mention ${agentName} in Linear or delegate an issue to it.`}
          </p>
        </div>
      </header>

      {listener?.state === 'failed' && (
        <div role="alert" className="flex gap-3 rounded-sm border border-health-error/25 bg-health-error-soft/50 px-3.5 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-health-error" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-sans text-[13px] font-medium text-health-error">Anima can’t receive Linear events</p>
            <p className="font-sans text-[12px] leading-relaxed text-text-muted">
              {listenerFailures[listener.reason ?? 'other']}
            </p>
          </div>
        </div>
      )}

      {data.clientRejected && (
        <div role="alert" className="flex gap-3 rounded-sm border border-health-error/25 bg-health-error-soft/50 px-3.5 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-health-error" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-sans text-[13px] font-medium text-health-error">Linear didn’t accept this app’s credentials</p>
            <p className="font-sans text-[12px] leading-relaxed text-text-muted">
              {data.clientSecretSaved
                ? 'Access couldn’t be renewed. Check the Client ID and Client secret on the app’s page in Linear, and replace the secret below if it changed.'
                : 'Access couldn’t be renewed. Add the app’s Client secret below, from its page in Linear.'}
            </p>
          </div>
        </div>
      )}

      {data.unansweredSessions ? (
        <div className="flex gap-3 rounded-sm border border-health-warn/30 bg-health-warn-soft px-3.5 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-health-warn" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <p className="font-sans text-[13px] font-medium text-health-warn-ink">{unansweredTitle(data.unansweredSessions)}</p>
            <p className="font-sans text-[12px] leading-relaxed text-text-muted">
              {agentName}’s run finished without answering, so Linear shows {data.unansweredSessions === 1 ? 'it' : 'them'} as
              stale. Reply in the session to wake {agentName} again, or stop it in Linear.
            </p>
          </div>
        </div>
      ) : null}

      <dl className="grid grid-cols-2 overflow-hidden rounded-sm border border-border-soft">
        <Fact label="Local listener" value={events} tone={listener?.state === 'failed' ? 'error' : undefined} />
        <Fact
          label="Last event"
          value={data.lastSignedWebhookAt ? formatRelativeShort(data.lastSignedWebhookAt, now) : 'None yet'}
          title={data.lastSignedWebhookAt ? shortIso(data.lastSignedWebhookAt) : undefined}
        />
        <Fact label="Client ID" value={data.clientId ?? '—'} mono wide />
        <ClientSecretFact agentId={agentId} data={data} disabled={busy} onChanged={onChanged} />
      </dl>

      {data.signatureFailures ? (
        <p className="font-sans text-[12px] leading-relaxed text-health-warn-ink">
          {data.signatureFailures} request{data.signatureFailures === 1 ? '' : 's'} claiming this app failed
          signature checks and were rejected.
        </p>
      ) : null}

      <p className="font-sans text-[12px] leading-relaxed text-text-subtle">
        No “Received by Anima.” in Linear after a mention? Check the{' '}
        <a href="/settings/server#public-url" className="underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted">
          public address
        </a>
        , and the app’s webhook URL and event subscriptions in Linear.
      </p>

      {error && (
        <p role="alert" className="font-sans text-[12px] text-health-error">
          {error}
        </p>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-soft pt-4">
        {confirming ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="font-sans text-[12px] text-text-muted">
              Stop Linear here? The app stays in Linear.
            </span>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void onRemove()}
              className="h-11 border-health-error/40 px-3 text-[13px] text-health-error hover:bg-health-error-soft/60 md:h-9"
            >
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="h-11 px-3 text-[13px] font-normal md:h-9"
            >
              Keep
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex min-h-11 items-center font-sans text-[12px] text-text-subtle underline decoration-text-subtle/40 underline-offset-2 hover:text-health-error md:min-h-0"
          >
            Disconnect
          </button>
        )}
        {!confirming && (
          <Button onClick={onClose} className="h-11 px-5 text-[13px] md:h-9">
            Done
          </Button>
        )}
      </footer>
    </div>
  );
}

// Only invalid_client says the secret is wrong; every other outcome left
// nothing stored and says so.
const clientSecretResults: Record<Exclude<LinearClientSecretResult, 'saved'>, string> = {
  rejected: 'Linear didn’t accept this Client secret. Check that it belongs to the app with this Client ID.',
  expired: 'Linear no longer accepts this authorization. Authorize again to reconnect.',
  unavailable: 'Couldn’t check it with Linear. Nothing was saved; try again later.',
  unsaved: 'Anima couldn’t store Linear’s answer, so nothing was saved. Try again. If Linear has ended this authorization, you’ll be asked to authorize again.',
  changed: 'This connection changed meanwhile, so nothing was saved.',
};

/**
 * Installations made before Anima kept the client secret can add it here.
 * Linear checks it before anything is stored, so a typo changes nothing.
 */
function ClientSecretFact({
  agentId,
  data,
  disabled,
  onChanged,
}: {
  agentId: string;
  data: LinearStatus;
  disabled: boolean;
  onChanged: () => Promise<LinearStatus | undefined>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = useId();
  const saved = Boolean(data.clientSecretSaved);
  const action = !saved ? 'Add' : data.clientRejected ? 'Replace' : '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = LinearClientSecretRequest.safeParse({ installationId: data.installationId, clientSecret: value.trim() });
    if (!parsed.success) {
      setMessage({ ok: false, text: 'Paste the Client secret exactly as Linear shows it.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const { result } = await saveLinearClientSecret(agentId, parsed.data);
      if (result === 'saved') setEditing(false);
      setMessage(result === 'saved' ? { ok: true, text: 'Client secret saved.' } : { ok: false, text: clientSecretResults[result] });
      void onChanged();
    } catch {
      // The answer was lost, not necessarily the save. Re-read what is stored:
      // a stored secret Linear accepts leaves nothing to try again.
      const now = await onChanged().catch(() => undefined);
      if (now?.clientSecretSaved && !now.clientRejected) setEditing(false);
      else setMessage({ ok: false, text: 'Couldn’t save it. Try again.' });
    } finally {
      setValue('');
      setSaving(false);
    }
  }

  return (
    <div className="col-span-2 min-w-0 border-t border-border-soft px-3.5 py-3">
      <dt className="font-sans text-[11px] tracking-wide text-text-subtle">Client secret</dt>
      <dd className="mt-1 min-w-0 space-y-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className={`font-serif text-[14px] ${saved ? 'text-text' : 'text-text-muted'}`}>
            {saved ? 'Stored on this machine' : 'Not stored'}
          </span>
          {action && !editing && (
            <button
              type="button"
              disabled={disabled}
              aria-label={`${action} Client secret`}
              onClick={() => {
                setMessage(null);
                setEditing(true);
              }}
              className="inline-flex min-h-11 shrink-0 items-center font-sans text-[12px] text-text-muted underline decoration-text-subtle/50 underline-offset-2 hover:text-text disabled:opacity-50 md:min-h-0"
            >
              {action}
            </button>
          )}
        </div>
        {editing && (
          <form onSubmit={(event) => void submit(event)} className="space-y-2">
            <label htmlFor={`${ids}-client-secret`} className="sr-only">
              Client secret
            </label>
            <input
              id={`${ids}-client-secret`}
              autoFocus
              required
              disabled={saving}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-describedby={`${ids}-client-secret-help`}
              {...notACredentialField}
              className={inputClass}
            />
            <p id={`${ids}-client-secret-help`} className="font-sans text-[11px] leading-relaxed text-text-subtle">
              From the app’s page in Linear. Linear checks it before Anima stores it on this machine.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={saving || disabled || !value.trim()} className="h-11 px-4 text-[13px] md:h-9">
                {saving ? 'Checking…' : 'Save'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setValue('');
                  setMessage(null);
                }}
                className="h-11 px-3 text-[13px] font-normal md:h-9"
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {message && (
          <p
            role={message.ok ? 'status' : 'alert'}
            className={`font-sans text-[12px] leading-relaxed ${message.ok ? 'text-health-ok' : 'text-health-error'}`}
          >
            {message.text}
          </p>
        )}
      </dd>
    </div>
  );
}

function Fact({
  label,
  value,
  mono = false,
  wide = false,
  tone,
  title,
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
  wide?: boolean;
  tone?: 'error';
}) {
  return (
    <div className={`min-w-0 border-border-soft px-3.5 py-3 ${wide ? 'col-span-2 border-t' : 'even:border-l'}`}>
      <dt className="font-sans text-[11px] tracking-wide text-text-subtle">{label}</dt>
      <dd
        title={title}
        className={`mt-1 break-all ${mono ? 'font-mono text-[12px]' : 'font-serif text-[14px]'} ${tone === 'error' ? 'text-health-error' : 'text-text'}`}
      >
        {value}
      </dd>
    </div>
  );
}

function Loading() {
  return (
    <p role="status" className="font-sans text-[13px] text-text-muted">
      Loading…
    </p>
  );
}

function ReadError({ what, refresh = false, onRetry }: { what: string; refresh?: boolean; onRetry: () => void }) {
  return (
    <p role="alert" className="font-sans text-[13px] text-health-error">
      Could not {refresh ? 'refresh' : 'read'} {what}.{' '}
      <button type="button" onClick={onRetry} className="inline-flex min-h-11 items-center px-1 underline md:min-h-8">
        Retry
      </button>
    </p>
  );
}

function LinearDialog({ busy, onClose, children }: { busy: boolean; onClose: () => void; children: ReactNode }) {
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
        className="flex h-full w-full flex-col border-border bg-surface shadow-deep md:h-auto md:max-h-[88dvh] md:max-w-[34rem] md:rounded-sm md:border"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border-soft px-5 py-2.5 md:px-6">
          <h2 id={titleId} className="font-sans text-[12px] font-medium uppercase tracking-[0.08em] text-text-muted">
            Linear
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close Linear settings"
            className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-elevated hover:text-text disabled:opacity-40 md:size-8"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-6 md:px-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
