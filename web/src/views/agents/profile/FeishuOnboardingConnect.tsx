import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ExternalLink, Loader2 } from 'lucide-react';
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
// The flow is auto-start: when the user submits name+role, the parent opens a
// new tab synchronously inside the click handler (popup-safe) and hands the
// window down here. We start app registration, point that tab at the returned
// Feishu authorization URL, and keep this tab on a "working, hang on" state
// while it polls. Slow or failed auto-creation reveals the existing-app
// credentials fallback in the same step.
// ---------------------------------------------------------------------------

export type FeishuOnboardingPhase = 'creating' | 'authorizing' | 'fallback' | 'connected';

const SLOW_THRESHOLD_MS = 10_000;
const POLL_INTERVAL_MS = 2000;

const ACTIVE_STATES = ['starting', 'waiting', 'slow_down', 'domain_switched'];

interface Props {
  agentId: string;
  agentName?: string;
  /** Returns the tab the parent opened synchronously on submit (popup-safe). */
  getAuthWindow?: () => Window | null;
  onConnect?: () => void;
  /** Reports the current phase up so the parent stepper can mark connect done. */
  onPhaseChange?: (phase: FeishuOnboardingPhase) => void;
  /** Forces a phase for dev/screenshot preview; disables live wiring. */
  previewPhase?: FeishuOnboardingPhase;
  /** Forces the fallback reason in preview so both body variants are shootable. */
  previewFallbackReason?: 'slow' | 'failed';
  /** Forces the popup-blocked promoted QR state in preview for screenshots. */
  previewPopupBlocked?: boolean;
}

export function FeishuOnboardingConnect({
  agentId,
  agentName,
  getAuthWindow,
  onConnect,
  onPhaseChange,
  previewPhase,
  previewFallbackReason,
  previewPopupBlocked,
}: Props) {
  const isPreview = previewPhase !== undefined;
  const [phase, setPhase] = useState<FeishuOnboardingPhase>(previewPhase ?? 'creating');

  // Surface phase changes to the parent (e.g. so the stepper reads fully-done at
  // the connected moment). Fires on mount too, including in preview.
  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);
  const [registration, setRegistration] = useState<AgentFeishuRegisterAppStatus | null>(null);
  const [error, setError] = useState<string | undefined>();

  // Existing-app fallback form
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [saving, setSaving] = useState(false);
  // Why we landed on the fallback: 'slow' (auto-creation past the 10s threshold,
  // or the user chose existing-app early) vs 'failed' (hard create failure). The
  // reason picks the body line so we never claim "taking longer" on a failure.
  const [fallbackReason, setFallbackReason] = useState<'slow' | 'failed'>(
    previewFallbackReason ?? 'slow',
  );

  const startedRef = useRef(false);
  const slowTimerRef = useRef<number | null>(null);

  const revealFallback = useCallback((reason: 'slow' | 'failed' = 'slow') => {
    // Once the fallback shows, the slow timer is moot — clear it so a late tick
    // can't flip a 'failed' reason back to 'slow'.
    if (slowTimerRef.current !== null) {
      window.clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    setFallbackReason(reason);
    setPhase((prev) => (prev === 'connected' ? prev : 'fallback'));
  }, []);

  // --- Auto-start app registration once, on mount ---------------------------
  useEffect(() => {
    if (isPreview || startedRef.current) return;
    startedRef.current = true;

    // If auto-creation stalls past the slow threshold, surface the fallback so
    // the user is never stranded on a spinner.
    slowTimerRef.current = window.setTimeout(() => revealFallback('slow'), SLOW_THRESHOLD_MS);

    void startAgentFeishuAppRegistration(agentId, { botName: agentName?.trim() || undefined })
      .then((next) => {
        setRegistration(next);
        const authWindow = getAuthWindow?.();
        if (next.verificationUrl && authWindow) {
          authWindow.location.href = next.verificationUrl;
        }
        if (next.state === 'connected') {
          handleConnected();
        } else if (next.verificationUrl) {
          setPhase((prev) => (prev === 'fallback' || prev === 'connected' ? prev : 'authorizing'));
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Could not start Feishu app setup');
        revealFallback('failed');
      });

    return () => {
      if (slowTimerRef.current !== null) window.clearTimeout(slowTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Poll while registration is active ------------------------------------
  const registrationActive =
    !isPreview && registration && ACTIVE_STATES.includes(registration.state);

  useEffect(() => {
    if (!registrationActive || !registration?.registrationId) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void fetchAgentFeishuAppRegistration(agentId, registration.registrationId)
        .then((next) => {
          if (cancelled) return;
          setRegistration(next);
          const authWindow = getAuthWindow?.();
          if (next.verificationUrl && authWindow && authWindow.location.href === 'about:blank') {
            authWindow.location.href = next.verificationUrl;
          }
          if (next.state === 'connected') handleConnected();
          if (next.state === 'failed') {
            setError(next.error?.description ?? next.error?.message);
            revealFallback('failed');
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Could not refresh Feishu app setup');
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, registration?.registrationId, registrationActive]);

  function handleConnected() {
    if (slowTimerRef.current !== null) window.clearTimeout(slowTimerRef.current);
    setPhase('connected');
    refreshDashboardData();
    onConnect?.();
  }

  async function handleUseExisting() {
    if (saving || !appId.trim() || !appSecret.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      await connectAgentFeishu(agentId, { appId: appId.trim(), appSecret: appSecret.trim() });
      setAppSecret('');
      handleConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Feishu connection failed');
    } finally {
      setSaving(false);
    }
  }

  // The same held URL backs every scan/deep-link surface; in preview there is no
  // live registration, so fall back to a stand-in so the affordances are shootable.
  const verificationUrl = registration?.verificationUrl ?? (isPreview ? PREVIEW_VERIFICATION_URL : undefined);

  // The auth tab is opened synchronously by the parent on submit; if the browser
  // blocked it, that ref is null. When blocked we promote the QR (the desktop→
  // phone bridge) since the tab path the body describes never happened.
  const authWindow = getAuthWindow?.();
  const popupBlocked = isPreview ? Boolean(previewPopupBlocked) : !authWindow || authWindow.closed;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-5">
      {(phase === 'creating' || phase === 'authorizing') && (
        <WorkingState
          phase={phase}
          popupBlocked={popupBlocked}
          verificationUrl={verificationUrl}
          onUseExisting={() => revealFallback('slow')}
        />
      )}

      {phase === 'fallback' && (
        <FallbackState
          appId={appId}
          appSecret={appSecret}
          reason={fallbackReason}
          saving={saving}
          verificationUrl={verificationUrl}
          onAppId={setAppId}
          onAppSecret={setAppSecret}
          onSubmit={() => void handleUseExisting()}
        />
      )}

      {phase === 'connected' && <ConnectedState />}

      {error && phase !== 'fallback' && (
        <p className="font-sans text-[12px] text-health-error">{error}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Working state — "creating" and "authorizing". Reads as in-progress, never done.
// ---------------------------------------------------------------------------

function WorkingState({
  onUseExisting,
  phase,
  popupBlocked,
  verificationUrl,
}: {
  onUseExisting: () => void;
  phase: 'creating' | 'authorizing';
  popupBlocked: boolean;
  verificationUrl?: string;
}) {
  // Once we have an auth URL we are in the authorizing phase. If the popup was
  // blocked the QR is promoted, and the tab-centric body would be false (no tab
  // opened) — so swap to the locked promoted heading/body for that case only.
  const promoted = phase === 'authorizing' && popupBlocked && Boolean(verificationUrl);
  const title = promoted
    ? 'Continue in the Feishu app'
    : phase === 'creating'
      ? 'Creating your Feishu app'
      : 'Waiting for you in Feishu';
  const body = promoted
    ? 'The Feishu tab did not open. Continue on your phone instead.'
    : phase === 'creating'
      ? 'We opened Feishu in a new tab. Confirm the app there to finish creating it. Keep this tab open while we finish.'
      : 'Confirm the new app in the Feishu tab we opened. This page updates on its own once you are done.';

  return (
    <div className="flex flex-col items-center px-2 py-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft/50">
        <Loader2 className="h-6 w-6 animate-spin text-accent" aria-hidden />
      </span>
      <div className="mt-4 font-serif text-[16px] font-semibold text-text">{title}</div>
      <p className="mt-1.5 max-w-sm text-balance font-serif text-[13px] leading-relaxed text-text-muted">
        {body}
      </p>

      {phase === 'authorizing' && verificationUrl && (
        <FeishuConnectAffordances popupBlocked={popupBlocked} verificationUrl={verificationUrl} />
      )}

      <div className="mt-6 flex w-full items-center gap-3">
        <span className="h-px flex-1 bg-border-soft" />
        <button
          type="button"
          onClick={onUseExisting}
          className="font-sans text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40"
        >
          Use an existing Feishu app instead
        </button>
        <span className="h-px flex-1 bg-border-soft" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scan / deep-link affordances. One held verification URL, surfaced by context:
//   - mobile  → a tap deep-link (you cannot scan your own screen)
//   - desktop → "Reopen the Feishu tab" + a modest QR, co-equal beneath the
//               passive primary; the QR is affordance-sized, not a hero graphic,
//               so the waiting-truth stays the visual anchor
//   - desktop, popup blocked → the QR is promoted (the desktop→phone bridge)
// The "then confirm" clause in the helper is load-bearing: scan is not completion.
// ---------------------------------------------------------------------------

function FeishuConnectAffordances({
  popupBlocked,
  verificationUrl,
}: {
  popupBlocked: boolean;
  verificationUrl: string;
}) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div className="mt-5 flex w-full flex-col items-center gap-2">
        <Button
          className="w-full"
          render={<a href={verificationUrl} rel="noreferrer" target="_blank" />}
        >
          Open Feishu
          <ExternalLink className="h-4 w-4" aria-hidden />
        </Button>
        <p className="max-w-xs text-balance font-sans text-[12px] leading-snug text-text-muted">
          We will open the Feishu app. Confirm the new app there to continue.
        </p>
      </div>
    );
  }

  // Promoted QR runs a touch larger than the co-equal default, but both stay
  // modest so the QR never dominates the passive waiting-truth above it.
  const qrSize = popupBlocked ? 128 : 104;

  return (
    <div className="mt-5 flex flex-col items-center gap-3">
      {!popupBlocked && (
        <a
          className="inline-flex items-center gap-1.5 rounded-sm border border-border-soft bg-surface px-3 py-2 font-sans text-[12px] font-medium text-text transition-colors hover:border-accent"
          href={verificationUrl}
          rel="noreferrer"
          target="_blank"
        >
          Reopen the Feishu tab
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}

      <div className="flex flex-col items-center gap-1.5">
        <span className="rounded-sm border border-border-soft bg-white p-2.5">
          <QRCode value={verificationUrl} size={qrSize} bgColor="#ffffff" fgColor="#1c1a17" level="M" />
        </span>
        <span className="font-sans text-[12px] font-medium text-text">Or scan with Feishu</span>
        <p className="max-w-[16rem] text-balance font-sans text-[11px] leading-snug text-text-muted">
          Scan this with the Feishu app, then confirm the new app on your phone.
        </p>
      </div>

      {popupBlocked && (
        <a
          className="inline-flex items-center gap-1.5 font-sans text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40"
          href={verificationUrl}
          rel="noreferrer"
          target="_blank"
        >
          Or open the Feishu tab
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fallback — existing-app credentials in the same step.
// ---------------------------------------------------------------------------

function FallbackState({
  appId,
  appSecret,
  onAppId,
  onAppSecret,
  onSubmit,
  reason,
  saving,
  verificationUrl,
}: {
  appId: string;
  appSecret: string;
  onAppId: (v: string) => void;
  onAppSecret: (v: string) => void;
  onSubmit: () => void;
  reason: 'slow' | 'failed';
  saving: boolean;
  verificationUrl?: string;
}) {
  const disabled = saving || !appId.trim() || !appSecret.trim();
  const body =
    reason === 'failed'
      ? "We couldn't finish creating the new app. Connect an app you already have to continue."
      : 'This is taking longer than usual. You can keep waiting in the Feishu tab, or connect an app you already have.';
  return (
    <div className="space-y-3">
      <div className="space-y-3 rounded-sm border border-border-soft bg-surface px-4 py-3">
        <div>
          <div className="font-serif text-[14px] font-semibold text-text">
            Connect an existing Feishu app
          </div>
          <p className="mt-1 font-serif text-[12px] leading-snug text-text-muted">{body}</p>
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

      {verificationUrl && (
        <a
          className="inline-flex items-center gap-1.5 font-sans text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40"
          href={verificationUrl}
          rel="noreferrer"
          target="_blank"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          Go back to the Feishu tab
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connected — the honest "your agent is live" moment. Brief, before redirect.
// The richer live-moment lives on the activity landing page.
// ---------------------------------------------------------------------------

function ConnectedState() {
  return (
    <div className="flex flex-col items-center px-2 py-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-health-ok-soft">
        <Check className="h-6 w-6 text-health-ok" aria-hidden />
      </span>
      <div className="mt-4 font-serif text-[16px] font-semibold text-text">Your agent is live</div>
      <p className="mt-1.5 max-w-sm text-balance font-serif text-[13px] leading-relaxed text-text-muted">
        Feishu is connected. Taking you to your agent now.
      </p>
    </div>
  );
}
