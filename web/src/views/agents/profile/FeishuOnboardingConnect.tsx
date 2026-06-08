import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import {
  connectAgentFeishu,
  fetchAgentFeishuAppRegistration,
  fetchAgentFeishuScopeStatus,
  refreshDashboardData,
  startAgentFeishuAppRegistration,
} from '@/api/agents';
import { Button } from '@/components/ui/button';
import { FeishuRecommendedPermissionsChecklist } from './FeishuRecommendedPermissionsChecklist';
import { queryKeys } from '@/lib/query-keys';
import {
  FEISHU_CONNECT_SLOW_SOFTEN_MS,
  FeishuConnectAffordances,
  FeishuCreatingAppLabel,
  FeishuExistingCredentialsCard,
  FeishuSlowLine,
  isFeishuRegistrationActive,
} from './feishu-connect-shared';
import {
  FEISHU_RECOMMENDED_SCOPES,
  type AgentFeishuRecommendedScopeStatusItem,
  type AgentFeishuRegisterAppStatus,
  type AgentFeishuScopeStatus,
} from '@shared/agent-config';

// A real Feishu authorization URL is only known at runtime. For dev/screenshot
// preview (no live registration), encode a stand-in so the QR/affordances render.
const PREVIEW_VERIFICATION_URL =
  'https://applink.feishu.cn/client/web_app/open?preview=onboarding-qr';

// ---------------------------------------------------------------------------
// FeishuOnboardingConnect
//
// Onboarding-only Feishu connect surface (Profile keeps FeishuConnectStepper).
// Dashboard-first, trimmed model: we never auto-open a tab. The parent starts
// registration from the create button and only mounts this step once the
// registration has produced a verification URL or hard-failed. From here the QR
// leads with scan-first affordances and the connected transition remains
// poll-driven. The existing-app credentials form is reached ONLY on a hard
// create failure. Once connected, the same surface requires recommended Feishu
// permissions before handing off to the activity page.
// ---------------------------------------------------------------------------

export type FeishuOnboardingPhase = 'creating' | 'authorizing' | 'fallback' | 'permissions' | 'connected';

const POLL_INTERVAL_MS = 2000;

interface Props {
  agentId: string;
  initialError?: string;
  initialRegistration?: AgentFeishuRegisterAppStatus | null;
  /**
   * Reports a successful connect and how it happened. `registerApp` = the app
   * was auto-created (an owner open_id exists, so the greeting will fire);
   * `manual` = existing-app credentials on the create-failure path (#154 leaves
   * it ungreeted — no owner open_id). The parent uses this to arm the "say hi"
   * banner only when a greeting will actually happen.
   */
  onConnect?: (info: { source: 'registerApp' | 'manual' }) => void;
  /** Persists the connected source in the parent while Step 3 is active. */
  onPendingConnectSource?: (source: 'registerApp' | 'manual') => void;
  /** Reports the current phase up so the parent stepper can mark connect done. */
  onPhaseChange?: (phase: FeishuOnboardingPhase) => void;
  /** Restores Step 3 after the parent remounts this component. */
  initialConnectSource?: 'registerApp' | 'manual';
  /** Forces a phase for dev/screenshot preview; disables live wiring. */
  previewPhase?: FeishuOnboardingPhase;
}

export function FeishuOnboardingConnect({
  agentId,
  initialError,
  initialRegistration,
  onConnect,
  onPendingConnectSource,
  onPhaseChange,
  initialConnectSource,
  previewPhase,
}: Props) {
  const isPreview = previewPhase !== undefined;
  const [phase, setPhase] = useState<FeishuOnboardingPhase>(
    previewPhase ?? phaseFromRegistration(initialRegistration, initialError, initialConnectSource),
  );

  // Surface phase changes to the parent (e.g. so the stepper reads fully-done at
  // the connected moment). Fires on mount too, including in preview.
  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);
  const [registration, setRegistration] = useState<AgentFeishuRegisterAppStatus | null>(
    initialRegistration ?? null,
  );
  const [error, setError] = useState<string | undefined>(initialError);

  // Existing-app fallback form — reached only on a hard create failure.
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retrySlow, setRetrySlow] = useState(false);
  const [pendingConnectSource, setPendingConnectSource] = useState<'registerApp' | 'manual' | null>(
    initialConnectSource ?? (initialRegistration?.state === 'connected' ? 'registerApp' : null),
  );
  const retrySlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const registrationRunRef = useRef(0);

  function clearRetrySlowTimer() {
    if (retrySlowTimerRef.current === null) return;
    clearTimeout(retrySlowTimerRef.current);
    retrySlowTimerRef.current = null;
  }

  function startRetrySlowTimer() {
    clearRetrySlowTimer();
    setRetrySlow(false);
    retrySlowTimerRef.current = setTimeout(() => {
      setRetrySlow(true);
    }, FEISHU_CONNECT_SLOW_SOFTEN_MS);
  }

  useEffect(() => () => {
    if (retrySlowTimerRef.current !== null) clearTimeout(retrySlowTimerRef.current);
  }, []);

  // --- Poll while registration is active ------------------------------------
  const registrationActive = !isPreview && isFeishuRegistrationActive(registration);

  useEffect(() => {
    if (!registrationActive || !registration?.registrationId) return undefined;
    let cancelled = false;
    const runId = registrationRunRef.current;
    const timer = window.setInterval(() => {
      void fetchAgentFeishuAppRegistration(agentId, registration.registrationId)
        .then((next) => {
          if (cancelled || runId !== registrationRunRef.current) return;
          setRegistration(next);
          if (next.verificationUrl) {
            clearRetrySlowTimer();
            setRetrying(false);
            setRetrySlow(false);
            setPhase((prev) => (prev === 'connected' ? prev : 'authorizing'));
          }
          if (next.state === 'connected') handleConnected('registerApp');
          if (next.state === 'failed') {
            clearRetrySlowTimer();
            setRetrying(false);
            setRetrySlow(false);
            setError(next.error?.description ?? next.error?.message);
            setPhase((prev) => (prev === 'connected' ? prev : 'fallback'));
          }
        })
        .catch((err) => {
          if (cancelled || runId !== registrationRunRef.current) return;
          setError(err instanceof Error ? err.message : 'Could not refresh Feishu app setup');
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, registration?.registrationId, registrationActive]);

  function handleConnected(source: 'registerApp' | 'manual') {
    clearRetrySlowTimer();
    setRetrying(false);
    setRetrySlow(false);
    setPendingConnectSource(source);
    onPendingConnectSource?.(source);
    setPhase('permissions');
    refreshDashboardData();
  }

  function finishConnected() {
    const source = pendingConnectSource ?? 'registerApp';
    setPhase('connected');
    onConnect?.({ source });
  }

  async function handleRetryRegistration() {
    if (retrying || isPreview) return;
    const runId = registrationRunRef.current + 1;
    registrationRunRef.current = runId;
    setRetrying(true);
    setRetrySlow(false);
    setError(undefined);
    setRegistration(null);
    setPhase('fallback');
    startRetrySlowTimer();
    let keepWaiting = false;
    try {
      const next = await startAgentFeishuAppRegistration(agentId);
      if (runId !== registrationRunRef.current) return;
      setRegistration(next);
      if (next.state === 'connected') {
        handleConnected('registerApp');
      } else if (next.state === 'failed') {
        setError(next.error?.description ?? next.error?.message);
        setPhase('fallback');
      } else if (next.verificationUrl) {
        setPhase('authorizing');
      } else if (isFeishuRegistrationActive(next)) {
        keepWaiting = true;
      }
    } catch (err) {
      if (runId !== registrationRunRef.current) return;
      setError(err instanceof Error ? err.message : 'Could not start creating your Feishu app.');
      setPhase('fallback');
    } finally {
      if (runId === registrationRunRef.current && !keepWaiting) {
        clearRetrySlowTimer();
        setRetrying(false);
        setRetrySlow(false);
      }
    }
  }

  async function handleUseExisting() {
    if (saving || !appId.trim() || !appSecret.trim()) return;
    registrationRunRef.current += 1;
    clearRetrySlowTimer();
    setRetrying(false);
    setRetrySlow(false);
    setRegistration(null);
    setSaving(true);
    setError(undefined);
    try {
      await connectAgentFeishu(agentId, { appId: appId.trim(), appSecret: appSecret.trim() });
      setAppSecret('');
      handleConnected('manual');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Feishu connection failed');
    } finally {
      setSaving(false);
    }
  }

  // The same held URL backs the scan/deep-link surfaces; in preview there is no
  // live registration, so fall back to a stand-in so the affordances are shootable.
  const verificationUrl = registration?.verificationUrl ?? (isPreview ? PREVIEW_VERIFICATION_URL : undefined);
  const authorizing = phase === 'authorizing' && Boolean(verificationUrl);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-5">
      {authorizing && verificationUrl ? (
        <FeishuConnectAffordances verificationUrl={verificationUrl} />
      ) : null}

      {phase === 'fallback' && (
        <FallbackState
          appId={appId}
          appSecret={appSecret}
          saving={saving}
          onAppId={setAppId}
          onAppSecret={setAppSecret}
          onRetry={() => void handleRetryRegistration()}
          onSubmit={() => void handleUseExisting()}
          retrying={retrying}
          retrySlow={retrySlow}
        />
      )}

      {phase === 'permissions' && (
        <RecommendedPermissionsState
          agentId={agentId}
          onContinue={finishConnected}
          preview={isPreview}
        />
      )}

      {phase === 'connected' && (
        <div className="flex justify-center py-6">
          <Loader2 className="h-6 w-6 animate-spin text-accent" aria-hidden />
        </div>
      )}

      {error && phase !== 'fallback' && (
        <p className="font-sans text-[12px] text-health-error">{error}</p>
      )}
    </div>
  );
}

function phaseFromRegistration(
  registration: AgentFeishuRegisterAppStatus | null | undefined,
  error: string | undefined,
  initialConnectSource?: 'registerApp' | 'manual',
): FeishuOnboardingPhase {
  if (initialConnectSource) return 'permissions';
  if (error || registration?.state === 'failed') return 'fallback';
  if (registration?.state === 'connected') return 'permissions';
  return 'authorizing';
}

export function RecommendedPermissionsState({
  agentId,
  onContinue,
  preview,
}: {
  agentId: string;
  onContinue: () => void;
  preview?: boolean;
}) {
  const [recheckResult, setRecheckResult] = useState<'granted' | 'missing' | null>(null);
  const [showPerms, setShowPerms] = useState(false);
  const [skipModal, setSkipModal] = useState(false);
  const scopeQuery = useQuery({
    queryKey: queryKeys.agentFeishuScopes(agentId),
    queryFn: () => fetchAgentFeishuScopeStatus(agentId),
    enabled: !preview,
  });
  const { isError, isFetching, refetch } = scopeQuery;
  const data = preview ? previewRecommendedScopeStatus() : scopeQuery.data;
  const state = data?.recommended.state;
  const effectiveState = recheckResult ?? state;

  async function handleRecheck() {
    setRecheckResult(null);
    const result = await refetch();
    const nextState = result.data?.recommended.state;
    if (nextState === 'granted' || nextState === 'missing') setRecheckResult(nextState);
  }

  if (!data && !isError) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-6 w-6 animate-spin text-accent" aria-hidden />
      </div>
    );
  }

  if (effectiveState === 'granted') {
    return (
      <div className="space-y-3 rounded-sm border border-health-ok/30 bg-health-ok-soft px-4 py-3">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-health-ok" />
          <p className="font-serif text-[13px] leading-snug text-text">
            Recommended Feishu permissions are on. Your Feishu bot is good to go.
          </p>
        </div>
        <Button className="w-full" onClick={onContinue}>Start activity</Button>
      </div>
    );
  }

  const authUrl = data?.recommended.authUrl;
  const scopes = recommendedScopesForDisplay(data);
  const confirmedMissing = recheckResult === 'missing';
  return (
    <>
      <FeishuRecommendedPermissionsChecklist
        scopes={scopes}
        authUrl={authUrl}
        confirmedMissing={confirmedMissing}
        showPerms={showPerms}
        onTogglePerms={() => setShowPerms((v) => !v)}
        onRecheck={() => void handleRecheck()}
        isRechecking={isFetching}
        statusLine={
          <>
            {data?.recommended.message && recheckResult !== 'missing' && (
              <div className="break-words font-sans text-[11px] text-text-subtle">
                Last check: {data.recommended.message}
              </div>
            )}
            {isError && !data?.recommended.message && (
              <div className="font-sans text-[11px] text-text-subtle">
                Could not check Feishu permissions.
              </div>
            )}
          </>
        }
        footer={
          <div className="border-t border-border-soft pt-3">
            <button
              type="button"
              onClick={() => setSkipModal(true)}
              className="font-sans text-[12px] text-text-muted underline decoration-text-subtle/40 underline-offset-2 transition-colors hover:text-text"
            >
              Skip for now
            </button>
          </div>
        }
      />

      {skipModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm space-y-4 rounded-lg border border-border-soft bg-surface px-5 py-4 shadow-lg">
            <div className="flex items-start gap-2.5">
              <CircleAlert className="mt-0.5 h-[18px] w-[18px] shrink-0 text-health-error" aria-hidden />
              <div className="space-y-1.5">
                <div className="font-serif text-[14px] font-semibold leading-tight text-text">
                  Skipping leaves some teammate features off
                </div>
                <p className="font-serif text-[13px] leading-relaxed text-text-muted">
                  Your Feishu bot keeps sending and receiving messages, but it won&rsquo;t recognize
                  teammates by name or work fully in group chats. Looking people up by email or phone
                  also stays off. You can authorize anytime from the agent&rsquo;s profile.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-4 pt-0.5">
              <button
                type="button"
                onClick={() => {
                  setSkipModal(false);
                  onContinue();
                }}
                className="font-sans text-[12px] text-text-muted underline decoration-text-subtle/40 underline-offset-2 transition-colors hover:text-text"
              >
                Skip anyway
              </button>
              <Button size="sm" onClick={() => setSkipModal(false)}>
                Keep setting up
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function recommendedScopesForDisplay(
  data: AgentFeishuScopeStatus | undefined,
): AgentFeishuRecommendedScopeStatusItem[] {
  // Always show the full recommended set (with each scope's grant flag) so the
  // list can mark passed vs still-missing after a recheck instead of dropping
  // the granted rows.
  if (data?.recommended.scopes.length) {
    return data.recommended.scopes;
  }
  return FEISHU_RECOMMENDED_SCOPES.map((scope) => ({
    capability: scope.capability,
    description: scope.description,
    granted: false,
    label: scope.label,
    scope: scope.scope,
  }));
}

function previewRecommendedScopeStatus(): AgentFeishuScopeStatus {
  const scopes = FEISHU_RECOMMENDED_SCOPES.map((scope) => ({
    capability: scope.capability,
    description: scope.description,
    granted: false,
    label: scope.label,
    scope: scope.scope,
  }));
  return {
    appId: 'cli_preview',
    connected: true,
    profileName: {
      authUrl: 'https://open.feishu.cn/app/cli_preview/auth?preview=recommended-scopes',
      granted: false,
      scope: 'contact:user.basic_profile:readonly',
      state: 'missing',
    },
    recommended: {
      authUrl: 'https://open.feishu.cn/app/cli_preview/auth?preview=recommended-scopes',
      granted: false,
      missingScopes: scopes.map((scope) => scope.scope),
      scopes,
      state: 'missing',
    },
  };
}

// ---------------------------------------------------------------------------
// Fallback — existing-app credentials in the same step. Reached ONLY on a hard
// registration failure (no user-initiated escape). The registration is dead and
// startedRef is already set, so there is no live waiting state to return to —
// the credentials form is the only forward path, so there is no "Go back".
// ---------------------------------------------------------------------------

function FallbackState({
  appId,
  appSecret,
  onAppId,
  onAppSecret,
  onRetry,
  onSubmit,
  retrying,
  retrySlow,
  saving,
}: {
  appId: string;
  appSecret: string;
  onAppId: (v: string) => void;
  onAppSecret: (v: string) => void;
  onRetry: () => void;
  onSubmit: () => void;
  retrying: boolean;
  retrySlow: boolean;
  saving: boolean;
}) {
  const disabled = saving || !appId.trim() || !appSecret.trim();
  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-sm border border-border-soft bg-surface px-4 py-3">
        <Button className="w-full" onClick={onRetry} disabled={saving || retrying}>
          {retrying ? <FeishuCreatingAppLabel /> : 'Try creating a new Feishu app again'}
        </Button>
        {retrying && retrySlow && <FeishuSlowLine />}
      </div>
      <FeishuExistingCredentialsCard
        appId={appId}
        appSecret={appSecret}
        description="We couldn't finish creating the new app. Connect an app you already have to continue."
        disabled={disabled}
        saving={saving}
        onAppId={onAppId}
        onAppSecret={onAppSecret}
        onSubmit={onSubmit}
      />
    </div>
  );
}
