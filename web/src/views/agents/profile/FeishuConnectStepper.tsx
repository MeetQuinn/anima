import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { QRCode } from 'react-qr-code';

import {
  connectAgentFeishu,
  fetchAgentFeishuAppRegistration,
  refreshDashboardData,
  startAgentFeishuAppRegistration,
} from '@/api/agents';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import type { AgentFeishuRegisterAppStatus } from '@shared/agent-config';

interface Props {
  agentId: string;
  agentName?: string;
  onConnect?: () => void;
}

type SetupMode = 'create' | 'existing';
type ExistingModeReason = 'manual' | 'failed';

const ACTIVE_STATES = ['starting', 'waiting', 'slow_down', 'domain_switched'];
const SLOW_SOFTEN_MS = 15_000;

export function FeishuConnectStepper({ agentId, agentName, onConnect }: Props) {
  const defaultBotName = agentName?.trim() || 'Anima {user}';
  const [setupMode, setSetupMode] = useState<SetupMode>('create');
  const [existingReason, setExistingReason] = useState<ExistingModeReason>('manual');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [registration, setRegistration] = useState<AgentFeishuRegisterAppStatus | null>(null);
  const [registering, setRegistering] = useState(false);
  const [registeringSlow, setRegisteringSlow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const createRunRef = useRef(0);
  const mountedRef = useRef(true);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disabled = saving || !appId.trim() || !appSecret.trim();
  const registrationActive = registration
    && ACTIVE_STATES.includes(registration.state);
  const verificationUrl = registration?.verificationUrl;
  const showingQr = Boolean(registrationActive && verificationUrl);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      createRunRef.current += 1;
      clearSlowTimer();
    };
  }, []);

  useEffect(() => {
    if (!registrationActive || !registration?.registrationId) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void fetchAgentFeishuAppRegistration(agentId, registration.registrationId)
        .then((next) => {
          if (cancelled) return;
          setRegistration(next);
          if (next.verificationUrl) clearSlowTimer();
          if (next.state === 'connected') {
            setSaved(true);
            clearSlowTimer();
            refreshDashboardData();
            onConnect?.();
          }
          if (next.state === 'failed') {
            clearSlowTimer();
            setExistingReason('failed');
            setError(next.error?.description ?? next.error?.message);
            setSetupMode('existing');
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

  function clearSlowTimer() {
    if (slowTimerRef.current === null) return;
    clearTimeout(slowTimerRef.current);
    slowTimerRef.current = null;
  }

  function startSlowTimer() {
    clearSlowTimer();
    setRegisteringSlow(false);
    slowTimerRef.current = setTimeout(() => {
      setRegisteringSlow(true);
    }, SLOW_SOFTEN_MS);
  }

  function isCurrentCreateRun(runId: number): boolean {
    return mountedRef.current && createRunRef.current === runId;
  }

  async function handleRegisterApp() {
    if (registering) return;
    const runId = createRunRef.current + 1;
    createRunRef.current = runId;
    setRegistering(true);
    startSlowTimer();
    setError(undefined);
    setSaved(false);
    try {
      const next = await startAgentFeishuAppRegistration(agentId, {
        botName: defaultBotName,
      });
      if (!isCurrentCreateRun(runId)) return;
      setRegistration(next);
      if (next.state === 'connected') {
        setSaved(true);
        clearSlowTimer();
        refreshDashboardData();
        onConnect?.();
      } else if (next.state === 'failed') {
        clearSlowTimer();
        setExistingReason('failed');
        setError(next.error?.description ?? next.error?.message);
        setSetupMode('existing');
      } else if (next.verificationUrl) {
        clearSlowTimer();
      }
    } catch (err) {
      if (!isCurrentCreateRun(runId)) return;
      clearSlowTimer();
      setError(err instanceof Error ? err.message : 'Could not start Feishu app registration');
      setExistingReason('failed');
      setSetupMode('existing');
    } finally {
      if (isCurrentCreateRun(runId)) setRegistering(false);
    }
  }

  async function handleConnect() {
    if (disabled) return;
    createRunRef.current += 1;
    clearSlowTimer();
    setRegistration(null);
    setRegistering(false);
    setRegisteringSlow(false);
    setSaving(true);
    setError(undefined);
    try {
      await connectAgentFeishu(agentId, {
        appId: appId.trim(),
        appSecret: appSecret.trim(),
      });
      setSaved(true);
      setAppSecret('');
      refreshDashboardData();
      onConnect?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Feishu connection failed');
    } finally {
      setSaving(false);
    }
  }

  function showExistingCredentials(reason: ExistingModeReason) {
    setExistingReason(reason);
    setSetupMode('existing');
  }

  function showCreate() {
    setSetupMode('create');
    setError(undefined);
  }

  return (
    <div className="space-y-5">
      {setupMode === 'create' && (
        <>
          {showingQr && verificationUrl ? (
            <FeishuConnectAffordances verificationUrl={verificationUrl} />
          ) : (
            <div className="rounded-sm border border-border-soft bg-surface-elevated px-4 py-3">
              <Button
                className="w-full"
                onClick={() => void handleRegisterApp()}
                disabled={registering || !!registrationActive}
              >
                {registering || registration?.state === 'starting' ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating your Feishu app…
                  </span>
                ) : (
                  'Create Feishu app'
                )}
              </Button>
              {(registering || registrationActive) && registeringSlow && (
                <p className="mt-2 text-center font-sans text-[12px] text-text-subtle">
                  This is taking longer than usual.
                </p>
              )}
            </div>
          )}
          <button
            type="button"
            className="font-sans text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40"
            onClick={() => showExistingCredentials('manual')}
          >
            Use an existing Feishu app
          </button>
        </>
      )}

      {setupMode === 'existing' && (
        <ExistingCredentialsForm
          appId={appId}
          appSecret={appSecret}
          disabled={disabled}
          reason={existingReason}
          saving={saving}
          onAppId={setAppId}
          onAppSecret={setAppSecret}
          onBack={showCreate}
          onSubmit={() => void handleConnect()}
        />
      )}

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

function FeishuConnectAffordances({ verificationUrl }: { verificationUrl: string }) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div className="flex flex-col items-center rounded-sm border border-border-soft bg-surface px-4 py-6 text-center">
        <Button
          className="w-full max-w-xs"
          render={<a href={verificationUrl} rel="noreferrer" target="_blank" />}
        >
          Open Feishu
          <ExternalLink className="h-4 w-4" aria-hidden />
        </Button>
        <p className="mt-3 max-w-xs text-balance font-serif text-[13px] leading-relaxed text-text-muted">
          Open Feishu to confirm the new app there.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center rounded-sm border border-border-soft bg-surface px-4 py-6 text-center">
      <span className="rounded-md border border-border-soft bg-white p-3">
        <QRCode value={verificationUrl} size={144} bgColor="#ffffff" fgColor="#1c1a17" level="M" />
      </span>
      <p className="mt-3 max-w-[18rem] text-balance font-serif text-[13px] leading-relaxed text-text-muted">
        Scan with Feishu, then confirm the new app there.
      </p>
      <a
        className="mt-3 inline-flex items-center gap-1.5 font-sans text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40"
        href={verificationUrl}
        rel="noreferrer"
        target="_blank"
      >
        Or open the Feishu tab in your browser
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </div>
  );
}

function ExistingCredentialsForm({
  appId,
  appSecret,
  disabled,
  onAppId,
  onAppSecret,
  onBack,
  onSubmit,
  reason,
  saving,
}: {
  appId: string;
  appSecret: string;
  disabled: boolean;
  onAppId: (value: string) => void;
  onAppSecret: (value: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  reason: ExistingModeReason;
  saving: boolean;
}) {
  return (
    <div className="space-y-3">
      {reason === 'manual' && (
        <button
          type="button"
          className="font-sans text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40"
          onClick={onBack}
        >
          Create a new Feishu app
        </button>
      )}
      <div className="space-y-3 rounded-sm border border-border-soft bg-surface px-4 py-3">
        <div>
          <div className="font-serif text-[14px] font-semibold text-text">
            Connect an existing Feishu app
          </div>
          <p className="mt-1 font-serif text-[12px] leading-snug text-text-muted">
            {reason === 'failed'
              ? "We couldn't finish creating the new app. Connect an app you already have to continue."
              : 'Connect an app you already have to continue.'}
          </p>
        </div>
        <CredentialField
          label="App ID"
          placeholder="cli_..."
          value={appId}
          onChange={onAppId}
        />
        <CredentialField
          label="App Secret"
          placeholder="App secret"
          secret
          value={appSecret}
          onChange={onAppSecret}
        />
        <p className="font-sans text-[12px] leading-snug text-text-muted">
          Find these on your app&apos;s Credentials &amp; Basic Info page in the Feishu Open Platform Developer Console.
        </p>
        <Button className="w-full" onClick={onSubmit} disabled={disabled}>
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Connecting…
            </span>
          ) : (
            'Connect Feishu app'
          )}
        </Button>
      </div>
    </div>
  );
}

export function CredentialField({
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
