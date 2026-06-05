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
// Dashboard-first model: we never auto-open a tab. On submit we move to the
// creating state and start app registration; when the registration returns a
// verification URL we stay on the dashboard and render the auth panel — a
// scan-first QR plus a user-initiated "Open the Feishu tab" link. Because the
// tab is only ever opened by a real click it can't be popup-blocked, and the
// connected transition is poll-driven (it never depended on owning a tab).
// Slow registration holds the waiting state; only a hard failure reveals the
// existing-app credentials fallback (also reachable as a user-initiated escape).
// ---------------------------------------------------------------------------

export type FeishuOnboardingPhase = 'creating' | 'authorizing' | 'fallback' | 'connected';

// How long a registration may stay pre-URL before we soften the waiting copy.
// This only changes the message; it never reveals credentials or a fallback.
const SLOW_SOFTEN_MS = 15_000;
const POLL_INTERVAL_MS = 2000;

const ACTIVE_STATES = ['starting', 'waiting', 'slow_down', 'domain_switched'];

interface Props {
  agentId: string;
  agentName?: string;
  onConnect?: () => void;
  /** Reports the current phase up so the parent stepper can mark connect done. */
  onPhaseChange?: (phase: FeishuOnboardingPhase) => void;
  /** Forces a phase for dev/screenshot preview; disables live wiring. */
  previewPhase?: FeishuOnboardingPhase;
  /** Forces the fallback reason in preview so both body variants are shootable. */
  previewFallbackReason?: 'slow' | 'failed';
  /** Forces the slow-softened waiting copy in preview for screenshots. */
  previewSlow?: boolean;
}

export function FeishuOnboardingConnect({
  agentId,
  agentName,
  onConnect,
  onPhaseChange,
  previewPhase,
  previewFallbackReason,
  previewSlow,
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
  // Why we landed on the fallback: 'slow' (the user chose existing-app from the
  // waiting state) vs 'failed' (a hard create failure). The reason picks the
  // body line so we never claim a failure when the user opted in deliberately.
  const [fallbackReason, setFallbackReason] = useState<'slow' | 'failed'>(
    previewFallbackReason ?? 'slow',
  );
  // Soften the waiting copy once the pre-URL wait runs long. Copy-only.
  const [slow, setSlow] = useState(false);

  const startedRef = useRef(false);
  const slowTimerRef = useRef<number | null>(null);

  const revealFallback = useCallback((reason: 'slow' | 'failed' = 'slow') => {
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

    // If the URL is slow to arrive, soften the waiting copy — but never reveal
    // credentials on slowness; only a hard failure does that.
    slowTimerRef.current = window.setTimeout(() => setSlow(true), SLOW_SOFTEN_MS);

    void startAgentFeishuAppRegistration(agentId, { botName: agentName?.trim() || undefined })
      .then((next) => {
        setRegistration(next);
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
          if (next.verificationUrl) {
            setPhase((prev) => (prev === 'fallback' || prev === 'connected' ? prev : 'authorizing'));
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

  // The same held URL backs the scan/deep-link surfaces; in preview there is no
  // live registration, so fall back to a stand-in so the affordances are shootable.
  const verificationUrl = registration?.verificationUrl ?? (isPreview ? PREVIEW_VERIFICATION_URL : undefined);
  const isSlow = isPreview ? Boolean(previewSlow) : slow;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-5">
      {(phase === 'creating' || phase === 'authorizing') && (
        <WorkingState
          phase={phase}
          slow={isSlow}
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
          onAppId={setAppId}
          onAppSecret={setAppSecret}
          onSubmit={() => void handleUseExisting()}
          onBack={() => setPhase(verificationUrl ? 'authorizing' : 'creating')}
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
// In the authorizing phase the held URL is present, so we render the scan-first
// auth panel beneath the waiting copy.
// ---------------------------------------------------------------------------

function WorkingState({
  onUseExisting,
  phase,
  slow,
  verificationUrl,
}: {
  onUseExisting: () => void;
  phase: 'creating' | 'authorizing';
  slow: boolean;
  verificationUrl?: string;
}) {
  // Mobile shows only the deep-link (no QR, no separate tab), so the authorizing
  // body must not promise "Scan the QR or open the Feishu tab" there.
  const isMobile = useIsMobile();
  const title = phase === 'creating' ? 'Creating your Feishu app' : 'Waiting for you in Feishu';
  const body =
    phase === 'creating'
      ? slow
        ? 'Still setting up. This is taking longer than usual.'
        : 'Setting up your Feishu app. This page updates on its own once it is ready.'
      : isMobile
        ? 'Open Feishu to confirm the new app. This page updates on its own once you are done.'
        : 'Scan the QR or open the Feishu tab to confirm the new app. This page updates on its own once you are done.';

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
        <FeishuConnectAffordances verificationUrl={verificationUrl} />
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
//   - desktop → the QR leads at full footprint (our users are scan-native), with
//               "Open the Feishu tab" as a secondary user-gesture link beneath it
// The "then confirm" clause in the helper is load-bearing: scan is not completion.
// ---------------------------------------------------------------------------

function FeishuConnectAffordances({ verificationUrl }: { verificationUrl: string }) {
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

  return (
    <div className="mt-5 flex flex-col items-center gap-4">
      <div className="flex flex-col items-center gap-2">
        <span className="rounded-md border border-border-soft bg-white p-3">
          <QRCode value={verificationUrl} size={144} bgColor="#ffffff" fgColor="#1c1a17" level="M" />
        </span>
        <span className="font-sans text-[13px] font-medium text-text">Scan with Feishu</span>
        <p className="max-w-[16rem] text-balance font-sans text-[11px] leading-snug text-text-muted">
          Scan this with the Feishu app, then confirm the new app on your phone.
        </p>
      </div>

      <a
        className="inline-flex items-center gap-1.5 font-sans text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40"
        href={verificationUrl}
        rel="noreferrer"
        target="_blank"
      >
        Open the Feishu tab
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fallback — existing-app credentials in the same step. Reached only when the
// user chooses it, or on a hard registration failure.
// ---------------------------------------------------------------------------

function FallbackState({
  appId,
  appSecret,
  onAppId,
  onAppSecret,
  onBack,
  onSubmit,
  reason,
  saving,
}: {
  appId: string;
  appSecret: string;
  onAppId: (v: string) => void;
  onAppSecret: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  reason: 'slow' | 'failed';
  saving: boolean;
}) {
  const disabled = saving || !appId.trim() || !appSecret.trim();
  const body =
    reason === 'failed'
      ? "We couldn't finish creating the new app. Connect an app you already have to continue."
      : 'Connect an app you already have to continue.';
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

      {/* Only the user-initiated ('slow') path can go back to a live waiting
          state. On hard failure the registration is dead and startedRef is
          already set, so 'creating' would be inert — the credentials form above
          is the escape, so we omit Go back. */}
      {reason !== 'failed' && (
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 font-sans text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden />
          Go back
        </button>
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
