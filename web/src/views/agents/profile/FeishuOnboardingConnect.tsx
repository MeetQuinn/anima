import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { QRCode } from 'react-qr-code';

import {
  connectAgentFeishu,
  fetchAgentFeishuAppRegistration,
  refreshDashboardData,
  startAgentFeishuAppRegistration,
} from '@/api/agents';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { CredentialField } from './FeishuConnectStepper';
import type { AgentFeishuRegisterAppStatus } from '@shared/agent-config';

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
// leads — a scan-first code plus a weakened "open the Feishu tab" link — and the
// connected transition remains poll-driven. The existing-app credentials form is
// reached ONLY on a hard create failure. On connect we hand off to the parent
// immediately (no separate success screen); the live-moment lives on the activity
// landing page.
// ---------------------------------------------------------------------------

export type FeishuOnboardingPhase = 'creating' | 'authorizing' | 'fallback' | 'connected';

const POLL_INTERVAL_MS = 2000;
const SLOW_SOFTEN_MS = 15_000;

const ACTIVE_STATES = ['starting', 'waiting', 'slow_down', 'domain_switched'];

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
  /** Reports the current phase up so the parent stepper can mark connect done. */
  onPhaseChange?: (phase: FeishuOnboardingPhase) => void;
  /** Forces a phase for dev/screenshot preview; disables live wiring. */
  previewPhase?: FeishuOnboardingPhase;
}

export function FeishuOnboardingConnect({
  agentId,
  initialError,
  initialRegistration,
  onConnect,
  onPhaseChange,
  previewPhase,
}: Props) {
  const isPreview = previewPhase !== undefined;
  const [phase, setPhase] = useState<FeishuOnboardingPhase>(
    previewPhase ?? phaseFromRegistration(initialRegistration, initialError),
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
    }, SLOW_SOFTEN_MS);
  }

  useEffect(() => () => {
    if (retrySlowTimerRef.current !== null) clearTimeout(retrySlowTimerRef.current);
  }, []);

  // --- Poll while registration is active ------------------------------------
  const registrationActive =
    !isPreview && registration && ACTIVE_STATES.includes(registration.state);

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
    setPhase('connected');
    refreshDashboardData();
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
      } else if (ACTIVE_STATES.includes(next.state)) {
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

// ---------------------------------------------------------------------------
// Scan / deep-link affordances — the trimmed connect screen. The QR leads (no
// heading, no waiting paragraph): one held verification URL surfaced by context:
//   - mobile  → a tap deep-link (you cannot scan your own screen)
//   - desktop → the QR leads at full footprint, with one supporting line and a
//               weakened "open the Feishu tab" link beneath it
// The "then confirm the new app there" clause is load-bearing: scan is not
// completion. The existing-app credentials form is failure-only, so there is no
// up-front escape link here.
// ---------------------------------------------------------------------------

function FeishuConnectAffordances({ verificationUrl }: { verificationUrl: string }) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div className="flex flex-col items-center px-2 py-6 text-center">
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
    <div className="flex flex-col items-center px-2 py-6 text-center">
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

function phaseFromRegistration(
  registration: AgentFeishuRegisterAppStatus | null | undefined,
  error: string | undefined,
): FeishuOnboardingPhase {
  if (error || registration?.state === 'failed') return 'fallback';
  if (registration?.state === 'connected') return 'connected';
  return 'authorizing';
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
          {retrying ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating your Feishu app…
            </span>
          ) : (
            'Try creating a new Feishu app again'
          )}
        </Button>
        {retrying && retrySlow && (
          <p className="text-center font-sans text-[12px] text-text-subtle">
            This is taking longer than usual.
          </p>
        )}
      </div>
      <div className="space-y-3 rounded-sm border border-border-soft bg-surface px-4 py-3">
        <div>
          <div className="font-serif text-[14px] font-semibold text-text">
            Connect an existing Feishu app
          </div>
          <p className="mt-1 font-serif text-[12px] leading-snug text-text-muted">
            We couldn&apos;t finish creating the new app. Connect an app you already have to continue.
          </p>
        </div>
        <CredentialField label="App ID" placeholder="cli_..." value={appId} onChange={onAppId} />
        <CredentialField
          label="App Secret"
          placeholder="App secret"
          secret
          value={appSecret}
          onChange={onAppSecret}
        />
        <p className="font-sans text-[12px] leading-snug text-text-muted">
          Find these on your app&apos;s Credentials &amp; Basic Info page in the Feishu Open Platform
          Developer Console.
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
