import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { LinearInstallRequest } from '@shared/linear';
import { defaultLinearAppName, linearAppCreationUrl } from '@shared/linear-setup';
import { fetchLinearSetup } from '@/api/linear';
import LinearWebhookSettings, {
  linearInputClass,
  linearSetupKey,
} from '@/components/LinearWebhookSettings';
import { Button } from '@/components/ui/button';

export function LinearConnectSteps({
  agentName,
  busy,
  disabled,
  onBusy,
  onInstall,
}: {
  agentName: string;
  busy: boolean;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onInstall: (input: LinearInstallRequest) => Promise<void>;
}) {
  const setup = useQuery({ queryKey: linearSetupKey, queryFn: fetchLinearSetup, retry: false });
  const [step, setStep] = useState<'create' | 'credentials'>('create');
  const [editingSetup, setEditingSetup] = useState(false);
  const [name, setName] = useState(() => defaultLinearAppName(agentName));
  const [callback, setCallback] = useState(`${window.location.origin}/api/linear/oauth/callback`);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  let creationUrl = '';
  if (setup.data?.webhookUrl) {
    try {
      creationUrl = linearAppCreationUrl({
        name,
        callbackUrl: callback,
        webhookUrl: setup.data.webhookUrl,
      });
    } catch {
      /* Editable fields are validated before opening Linear. */
    }
  }
  async function install(event: FormEvent) {
    event.preventDefault();
    if (!setup.data || setup.isError) return;
    const parsed = LinearInstallRequest.safeParse({
      clientId: clientId.trim(),
      signingSecret: secret.trim(),
      callbackUrl: callback,
      listener: setup.data.listener,
    });
    if (!parsed.success) {
      setError('Check the client ID, signing secret and callback URL.');
      return;
    }
    setError('');
    try {
      await onInstall(parsed.data);
    } finally {
      setSecret('');
    }
  }
  if (setup.isPending)
    return (
      <p role="status" className="text-sm text-text-muted">
        Loading machine settings…
      </p>
    );
  if (!setup.data)
    return (
      <p role="alert" className="text-sm text-health-error">
        Could not read machine settings.{' '}
        <button
          type="button"
          className="min-h-[44px] underline"
          onClick={() => void setup.refetch()}
        >
          Retry
        </button>
      </p>
    );
  if (!setup.data.webhookUrl || editingSetup)
    return (
      <div className="space-y-4">
        <LinearWebhookSettings onSaved={() => setEditingSetup(false)} onBusy={onBusy} />
        {setup.data.webhookUrl && (
          <Button variant="ghost" disabled={busy} onClick={() => setEditingSetup(false)}>
            Back to connection
          </Button>
        )}
      </div>
    );
  return (
    <div className="space-y-5">
      {setup.isError && (
        <p role="alert" className="text-sm text-health-error">
          Could not refresh machine settings.{' '}
          <button type="button" className="min-h-[44px] underline" onClick={() => void setup.refetch()}>
            Retry
          </button>
        </p>
      )}
      <ol
        aria-label="Connection steps"
        className="flex flex-wrap gap-x-5 gap-y-2 border-b border-border-soft pb-4 font-sans text-[12px] text-text-muted"
      >
        <li
          aria-current={step === 'create' ? 'step' : undefined}
          className={step === 'create' ? 'font-medium text-accent' : ''}
        >
          1. Create app
        </li>
        <li
          aria-current={step === 'credentials' ? 'step' : undefined}
          className={step === 'credentials' ? 'font-medium text-accent' : ''}
        >
          2. Connect
        </li>
        <li>3. Authorize</li>
      </ol>
      {step === 'create' ? (
        <div className="space-y-4">
          <div>
            <h3 className="font-serif text-[20px] font-semibold text-text">
              Give {agentName} a Linear identity
            </h3>
            <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
              Create a separate app for this agent. Its name, callback address and event
              subscriptions are already filled in. Review them in Linear, then create the app.
            </p>
          </div>
          <div className="rounded-sm border border-border-soft px-3 py-3">
            <p className="text-[12px] text-text-muted">Shared webhook</p>
            <p className="mt-1 break-all font-mono text-[12px] text-text">
              {setup.data.webhookUrl}
            </p>
            <button
              type="button"
              onClick={() => setEditingSetup(true)}
              className="mt-1 min-h-[44px] text-[12px] text-accent underline"
            >
              Edit machine settings
            </button>
          </div>
          <details>
            <summary className="cursor-pointer py-2 text-[12px] text-text-muted">
              App name and callback URL
            </summary>
            <div className="mt-2 space-y-3">
              <label className="block">
                <span className="mb-1 block text-[12px] text-text-muted">App name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={linearInputClass}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] text-text-muted">OAuth callback URL</span>
                <input
                  type="url"
                  value={callback}
                  onChange={(e) => setCallback(e.target.value)}
                  className={linearInputClass}
                />
              </label>
              <p className="text-[12px] text-text-muted">
                The callback returns to this dashboard. Keep the same address when authorizing the
                app.
              </p>
            </div>
          </details>
          {!creationUrl && (
            <p role="alert" className="text-[13px] text-health-error">
              Use a 2–80 character app name without “Linear” or a URL, and an HTTPS or loopback
              dashboard callback ending in /api/linear/oauth/callback.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {creationUrl && !setup.isError && !disabled && (
              <a
                href={creationUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => setStep('credentials')}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-sm bg-primary px-4 text-[13px] text-primary-foreground"
              >
                Create app in Linear <ExternalLink className="size-3.5" />
              </a>
            )}
            <Button
              variant="ghost"
              disabled={disabled || setup.isError || !creationUrl}
              onClick={() => setStep('credentials')}
            >
              I already have an app
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void install(event)} className="space-y-4">
          <h3 className="font-serif text-[20px] font-semibold text-text">Connect your app</h3>
          <p className="text-[13px] leading-relaxed text-text-muted">
            In the Linear app settings, copy the Client ID and Webhook signing secret below. You’ll
            then authorize workspace and team access.
          </p>
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-muted">Client ID</span>
            <input
              required
              disabled={busy}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className={linearInputClass}
              autoComplete="off"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-muted">Webhook signing secret</span>
            <input
              type="password"
              required
              disabled={busy}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className={linearInputClass}
              autoComplete="new-password"
            />
          </label>
          <p className="text-[12px] text-text-muted">
            Secrets stay on this machine and are not shown again.
          </p>
          {error && (
            <p role="alert" className="text-[13px] text-health-error">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSecret('');
                setStep('create');
              }}
            >
              Back
            </Button>
            <Button
              type="submit"
              className="min-h-[44px]"
              disabled={busy || disabled || setup.isError}
            >
              {busy ? 'Preparing…' : 'Prepare authorization'}
            </Button>
          </div>
        </form>
      )}
      {setup.isError && (
        <p role="alert" className="text-[13px] text-health-error">
          Machine settings could not be refreshed.{' '}
          <button
            type="button"
            className="min-h-[44px] underline"
            onClick={() => void setup.refetch()}
          >
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
