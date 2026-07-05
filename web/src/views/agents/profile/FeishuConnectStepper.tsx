import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

import {
  connectAgentFeishu,
  refreshDashboardData,
  startAgentFeishuAppRegistration,
} from '@/api/agents';
import { Button } from '@/components/ui/button';
import {
  isFeishuRegistrationActive,
  useFeishuRegistrationPoll,
} from '@/hooks/useFeishuRegistrationPoll';
import {
  FEISHU_CONNECT_SLOW_SOFTEN_MS,
  FeishuConnectAffordances,
  FeishuCreatingAppLabel,
  FeishuExistingCredentialsCard,
  FeishuSlowLine,
} from './feishu-connect-shared';
import type { AgentFeishuRegisterAppStatus } from '@shared/agent-config';

interface Props {
  agentId: string;
  agentName?: string;
  onConnect?: () => void;
}

type SetupMode = 'create' | 'existing';
type ExistingModeReason = 'manual' | 'failed';

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
  const registrationActive = isFeishuRegistrationActive(registration);
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

  useFeishuRegistrationPoll({
    agentId,
    enabled: registrationActive,
    registration,
    onStatus: (next) => {
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
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Could not refresh Feishu app registration');
    },
  });

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
    }, FEISHU_CONNECT_SLOW_SOFTEN_MS);
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
      setError(err instanceof Error ? err.message : 'Could not start creating your Feishu app.');
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

  function retryCreateApp() {
    clearSlowTimer();
    setRegistration(null);
    setError(undefined);
    setExistingReason('manual');
    setSetupMode('create');
    void handleRegisterApp();
  }

  return (
    <div className="space-y-5">
      {setupMode === 'create' && (
        <>
          {showingQr && verificationUrl ? (
            <FeishuConnectAffordances frame="card" verificationUrl={verificationUrl} />
          ) : (
            <div className="rounded-sm border border-border-soft bg-surface-elevated px-4 py-3">
              <Button
                className="w-full"
                onClick={() => void handleRegisterApp()}
                disabled={registering || !!registrationActive}
              >
                {registering || registrationActive ? (
                  <FeishuCreatingAppLabel />
                ) : (
                  'Create Feishu app'
                )}
              </Button>
              {(registering || registrationActive) && registeringSlow && (
                <div className="mt-2">
                  <FeishuSlowLine />
                </div>
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
          onRetry={retryCreateApp}
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

function ExistingCredentialsForm({
  appId,
  appSecret,
  disabled,
  onAppId,
  onAppSecret,
  onBack,
  onRetry,
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
  onRetry: () => void;
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
      {reason === 'failed' && (
        <div className="rounded-sm border border-border-soft bg-surface px-4 py-3">
          <Button className="w-full" onClick={onRetry} disabled={saving}>
            Try creating a new Feishu app again
          </Button>
        </div>
      )}
      <FeishuExistingCredentialsCard
        appId={appId}
        appSecret={appSecret}
        description={reason === 'failed'
          ? "We couldn't finish creating the new app. Connect an app you already have to continue."
          : 'Connect an app you already have to continue.'}
        disabled={disabled}
        saving={saving}
        onAppId={onAppId}
        onAppSecret={onAppSecret}
        onSubmit={onSubmit}
      />
    </div>
  );
}
