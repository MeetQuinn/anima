import { useEffect, useState } from 'react';
import { Check, ExternalLink, Loader2 } from 'lucide-react';

import {
  connectAgentFeishu,
  fetchAgentFeishuAppRegistration,
  refreshDashboardData,
  startAgentFeishuAppRegistration,
} from '@/api/agents';
import { Button } from '@/components/ui/button';
import type { AgentFeishuRegisterAppStatus } from '@shared/agent-config';

interface Props {
  agentId: string;
  onConnect?: () => void;
}

export function FeishuConnectStepper({ agentId, onConnect }: Props) {
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [botOpenId, setBotOpenId] = useState('');
  const [verificationToken, setVerificationToken] = useState('');
  const [encryptKey, setEncryptKey] = useState('');
  const [registration, setRegistration] = useState<AgentFeishuRegisterAppStatus | null>(null);
  const [registering, setRegistering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const disabled = saving || !appId.trim() || !appSecret.trim();
  const registrationActive = registration
    && ['starting', 'waiting', 'slow_down', 'domain_switched'].includes(registration.state);

  useEffect(() => {
    if (!registrationActive || !registration?.registrationId) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void fetchAgentFeishuAppRegistration(agentId, registration.registrationId)
        .then((next) => {
          if (cancelled) return;
          setRegistration(next);
          if (next.state === 'connected') {
            setSaved(true);
            refreshDashboardData();
            onConnect?.();
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Could not refresh Feishu app registration');
        });
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agentId, onConnect, registration?.registrationId, registrationActive]);

  async function handleRegisterApp() {
    if (registering) return;
    setRegistering(true);
    setError(undefined);
    setSaved(false);
    try {
      const next = await startAgentFeishuAppRegistration(agentId);
      setRegistration(next);
      if (next.state === 'connected') {
        setSaved(true);
        refreshDashboardData();
        onConnect?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Feishu app registration');
    } finally {
      setRegistering(false);
    }
  }

  async function handleConnect() {
    if (disabled) return;
    setSaving(true);
    setError(undefined);
    try {
      await connectAgentFeishu(agentId, {
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        botOpenId: botOpenId.trim() || undefined,
        encryptKey: encryptKey.trim() || undefined,
        verificationToken: verificationToken.trim() || undefined,
      });
      setSaved(true);
      refreshDashboardData();
      onConnect?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Feishu connection failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-sm border border-border-soft bg-surface-elevated px-4 py-3">
        <div className="font-serif text-[14px] font-semibold text-text">
          Create and prefill a Feishu app
        </div>
        <p className="font-serif mt-1 text-[13px] leading-snug text-text-muted">
          Anima opens a Feishu authorization link, saves the returned credentials, then validates
          message delivery. You may still need to confirm bot permissions and event delivery in Feishu.
        </p>
        <Button
          className="mt-3 w-full"
          onClick={() => void handleRegisterApp()}
          disabled={registering || !!registrationActive}
        >
          {registering || registration?.state === 'starting' ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating Feishu app…
            </span>
          ) : (
            'Create Feishu app'
          )}
        </Button>
      </div>

      {registration && (
        <RegistrationStatusCard status={registration} />
      )}

      <details className="rounded-sm border border-border-soft bg-surface px-4 py-3">
        <summary className="cursor-pointer font-serif text-[13px] font-semibold text-text">
          Use existing Feishu app credentials
        </summary>
        <div className="mt-4 space-y-3">
          <CredentialField
            label="App ID"
            placeholder="cli_..."
            value={appId}
            onChange={setAppId}
          />
          <CredentialField
            label="App Secret"
            placeholder="App secret"
            secret
            value={appSecret}
            onChange={setAppSecret}
          />
          <details className="rounded-sm border border-border-soft bg-surface-elevated px-3 py-2">
            <summary className="cursor-pointer font-sans text-[12px] font-medium text-text-muted">
              Advanced optional fields
            </summary>
            <div className="mt-3 space-y-3">
              <CredentialField
                label="Bot Open ID"
                optional
                placeholder="ou_..."
                value={botOpenId}
                onChange={setBotOpenId}
              />
              <CredentialField
                label="Verification Token"
                optional
                placeholder="Event subscription token"
                secret
                value={verificationToken}
                onChange={setVerificationToken}
              />
              <CredentialField
                label="Encrypt Key"
                optional
                placeholder="Encrypted event key"
                secret
                value={encryptKey}
                onChange={setEncryptKey}
              />
            </div>
          </details>

          <Button className="w-full" onClick={() => void handleConnect()} disabled={disabled}>
            {saving ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving…
              </span>
            ) : (
              'Save Feishu connection'
            )}
          </Button>
        </div>
      </details>

      {error && (
        <p className="font-sans text-[12px] text-health-error">{error}</p>
      )}

      {saved && (
        <div className="flex items-center gap-2 rounded-sm border border-health-ok/30 bg-health-ok-soft px-4 py-3">
          <Check className="h-4 w-4 text-health-ok" />
          <span className="font-serif text-[13px] text-text">Feishu app credentials saved.</span>
        </div>
      )}
    </div>
  );
}

function RegistrationStatusCard({ status }: { status: AgentFeishuRegisterAppStatus }) {
  const message = registrationMessage(status);
  return (
    <div className="space-y-3 rounded-sm border border-border-soft bg-surface px-4 py-3">
      <div className="flex items-start gap-3">
        {status.state === 'connected' ? (
          <Check className="mt-0.5 h-4 w-4 text-health-ok" />
        ) : status.state === 'failed' ? (
          <span className="mt-1 h-2.5 w-2.5 rounded-full bg-health-error" />
        ) : (
          <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-accent" />
        )}
        <div className="min-w-0">
          <div className="font-serif text-[13px] font-semibold text-text">{message.title}</div>
          <p className="mt-1 font-serif text-[12px] leading-snug text-text-muted">{message.body}</p>
        </div>
      </div>
      {status.verificationUrl && status.state !== 'connected' && status.state !== 'failed' && (
        <a
          className="inline-flex items-center gap-2 rounded-sm border border-border-soft bg-surface-elevated px-3 py-2 font-sans text-[12px] font-medium text-text hover:border-accent"
          href={status.verificationUrl}
          rel="noreferrer"
          target="_blank"
        >
          Open Feishu authorization link
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}
    </div>
  );
}

function registrationMessage(status: AgentFeishuRegisterAppStatus): { body: string; title: string } {
  if (status.state === 'connected') {
    return {
      title: 'Feishu app credentials saved',
      body: 'Now send a Feishu message to validate event delivery and the first reply.',
    };
  }
  if (status.state === 'failed') {
    return {
      title: 'Feishu app creation stopped',
      body: status.error?.description ?? status.error?.message ?? 'Retry app creation, or use existing app credentials below.',
    };
  }
  if (status.state === 'slow_down') {
    return {
      title: 'Waiting for Feishu authorization',
      body: 'Feishu asked Anima to poll more slowly. Keep the authorization page open.',
    };
  }
  if (status.state === 'domain_switched') {
    return {
      title: 'Waiting in the matching Feishu domain',
      body: 'Continue in the Feishu authorization page shown by Anima.',
    };
  }
  if (status.verificationUrl) {
    return {
      title: 'Confirm the Feishu app',
      body: status.expireIn
        ? `Open the link and confirm the app in Feishu. The link expires in about ${Math.ceil(status.expireIn / 60)} minutes.`
        : 'Open the link and confirm the app in Feishu.',
    };
  }
  return {
    title: 'Preparing Feishu authorization',
    body: 'Anima is asking Feishu for an app creation link.',
  };
}

function CredentialField({
  label,
  onChange,
  optional = false,
  placeholder,
  secret = false,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  optional?: boolean;
  placeholder: string;
  secret?: boolean;
  value: string;
}) {
  return (
    <label className="block">
      <span className="font-sans mb-1.5 block text-[12px] font-medium uppercase tracking-[0.08em] text-text-muted">
        {label}
        {optional ? <span className="normal-case tracking-normal text-text-subtle"> · optional</span> : null}
      </span>
      <input
        autoComplete="off"
        className="w-full rounded-sm border border-border-soft bg-surface px-3 py-2 font-mono text-[12px] text-text placeholder:font-sans placeholder:text-text-subtle focus:border-accent focus:outline-none"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        type={secret ? 'password' : 'text'}
        value={value}
      />
    </label>
  );
}
