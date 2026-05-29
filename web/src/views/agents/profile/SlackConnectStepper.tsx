import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import {
  connectAgentSlack,
  refreshDashboardData,
  validateAgentSlackTokens,
} from '@/api/agents';
import type { SlackTokenValidation, SlackValidateResponse } from '@/api/agents';

// ---------------------------------------------------------------------------
// Copy — user-facing strings for each reason code
// (iris owns these; placeholders will be swapped in when her copy table lands)
// ---------------------------------------------------------------------------

const REASON_COPY: Record<NonNullable<SlackTokenValidation['reason']>, string> = {
  missing_token: '', // quiet — no red while mid-typing
  wrong_token_type: '', // handled inline with routing hint — see reasonMessage()
  unknown_token_type:
    "This doesn't look like a Slack token. Bot tokens start with `xoxb-`, app-level tokens with `xapp-`.",
  invalid_token:
    "Slack didn't recognize this token. Check you copied the whole thing and the app is still installed.",
  missing_connections_write:
    "This App-Level Token is missing the `connections:write` scope. Regenerate it with that scope checked (Basic Information → App-Level Tokens).",
  not_bot_token:
    "This isn't a Bot User token. Copy the one labeled Bot User OAuth Token under OAuth & Permissions — it starts with `xoxb-`.",
  slack_api_error: "Couldn't reach Slack to check this token. Try again in a moment.",
};

const MISMATCH_COPY =
  'These two tokens are from different Slack apps. Make sure both came from the same app you just created.';

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------

type FieldState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'verified'; result: SlackTokenValidation }
  | { status: 'failed'; result: SlackTokenValidation };

function fieldStateFrom(v: SlackTokenValidation): FieldState {
  return v.valid ? { status: 'verified', result: v } : { status: 'failed', result: v };
}

function reasonMessage(result: SlackTokenValidation, field: 'app' | 'bot'): string {
  if (!result.reason || result.reason === 'missing_token') return '';
  if (result.reason === 'wrong_token_type') {
    return field === 'app'
      ? "That’s a Bot token (`xoxb-…`). The App-Level Token goes here — it starts with `xapp-`."
      : "That’s an App-Level Token (`xapp-…`). The Bot User OAuth Token goes here — it starts with `xoxb-`.";
  }
  return REASON_COPY[result.reason] || 'Validation failed.';
}

// ---------------------------------------------------------------------------
// StepCircle
// ---------------------------------------------------------------------------

function StepCircle({
  n,
  done,
  active,
  onClick,
}: {
  n: number;
  done: boolean;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <span
      onClick={onClick}
      title={onClick ? 'Go back to this step' : undefined}
      className={[
        'font-sans mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold transition-opacity',
        done
          ? 'border-health-ok bg-health-ok-soft text-health-ok'
          : active
            ? 'border-health-warn/50 text-health-warn'
            : 'border-border text-text-subtle',
        onClick ? 'cursor-pointer hover:opacity-60' : '',
      ].join(' ')}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : n}
    </span>
  );
}

// ---------------------------------------------------------------------------
// FieldStatus — inline pending / verified / failed indicator
// ---------------------------------------------------------------------------

function FieldStatus({ state, field }: { state: FieldState; field: 'app' | 'bot' }) {
  if (state.status === 'idle') return null;
  if (state.status === 'pending') {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 font-sans text-[12px] text-text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Checking with Slack…</span>
      </div>
    );
  }
  if (state.status === 'verified') {
    const label =
      field === 'bot' && state.result.botName
        ? `@${state.result.botName}${state.result.workspaceName ? ` · ${state.result.workspaceName}` : ''}`
        : (state.result.workspaceName ?? 'Verified');
    return (
      <div className="mt-1.5 flex items-center gap-1.5 font-sans text-[12px] text-health-ok">
        <Check className="h-3.5 w-3.5 shrink-0" />
        <span>{label}</span>
      </div>
    );
  }
  // failed
  return (
    <div className="mt-1.5 flex items-start gap-1.5 font-sans text-[12px] text-health-error">
      <X className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{reasonMessage(state.result, field)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConnectionSuccess — shown when both tokens verify and connection.valid
// ---------------------------------------------------------------------------

function ConnectionSuccess({ conn }: { conn: SlackValidateResponse['connection'] }) {
  return (
    <div className="flex items-center gap-3 rounded-sm border border-health-ok/30 bg-health-ok-soft px-4 py-3">
      <div className="flex flex-1 min-w-0 items-center gap-2">
        {conn.workspaceIconUrl && (
          <img
            src={conn.workspaceIconUrl}
            alt=""
            className="h-5 w-5 shrink-0 rounded-sm object-cover"
          />
        )}
        <span className="font-serif text-[13px] text-text">
          Connected to <strong>{conn.workspaceName ?? 'your workspace'}</strong>
          {conn.botName ? (
            <>
              {' '}as{' '}
              {conn.botAvatarUrl && (
                <img
                  src={conn.botAvatarUrl}
                  alt=""
                  className="mx-0.5 inline h-4 w-4 rounded-full object-cover align-middle"
                />
              )}
              <strong>@{conn.botName}</strong>
            </>
          ) : null}
        </span>
      </div>
      <Check className="h-4 w-4 shrink-0 text-health-ok" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SlackConnectStepper
// ---------------------------------------------------------------------------

interface Props {
  agentId: string;
  onConnect?: () => void;
}

export function SlackConnectStepper({ agentId, onConnect }: Props) {
  const [step1Done, setStep1Done] = useState(false);
  const [appToken, setAppToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [appState, setAppState] = useState<FieldState>({ status: 'idle' });
  const [botState, setBotState] = useState<FieldState>({ status: 'idle' });
  const [connectionResult, setConnectionResult] = useState<SlackValidateResponse['connection'] | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | undefined>();
  const [connected, setConnected] = useState(false);

  const validateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const appVerified = appState.status === 'verified';
  const botVerified = botState.status === 'verified';

  const step2Active = step1Done;
  const step2Done = appVerified;
  const step3Active = step1Done && step2Done;
  const step3Done = botVerified;

  // ---------------------------------------------------------------------------
  // Validation helpers
  // ---------------------------------------------------------------------------

  const validateApp = useCallback(
    async (token: string) => {
      if (!token.trim()) return;
      setAppState({ status: 'pending' });
      setConnectionResult(null);
      try {
        const res = await validateAgentSlackTokens(agentId, { appToken: token.trim() });
        if (res.app) setAppState(fieldStateFrom(res.app));
      } catch {
        setAppState({ status: 'failed', result: { valid: false, expected: 'app', reason: 'slack_api_error' } });
      }
    },
    [agentId],
  );

  const validateBot = useCallback(
    async (token: string) => {
      if (!token.trim()) return;
      setBotState({ status: 'pending' });
      setConnectionResult(null);
      try {
        const res = await validateAgentSlackTokens(agentId, { botToken: token.trim() });
        if (res.bot) setBotState(fieldStateFrom(res.bot));
      } catch {
        setBotState({ status: 'failed', result: { valid: false, expected: 'bot', reason: 'slack_api_error' } });
      }
    },
    [agentId],
  );

  async function handleConnect() {
    if (connecting || connected) return;
    setConnecting(true);
    setConnectError(undefined);
    try {
      await connectAgentSlack(agentId, { appToken: appToken.trim(), botToken: botToken.trim() });
      setConnected(true);
      refreshDashboardData();
      onConnect?.();
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'Connection failed');
      setConnectionResult(null);
    } finally {
      setConnecting(false);
    }
  }

  async function checkConnection() {
    try {
      const res = await validateAgentSlackTokens(agentId, {
        appToken: appToken.trim(),
        botToken: botToken.trim(),
      });
      if (res.connection.valid) {
        setConnectionResult(res.connection);
        void handleConnect();
      } else if (res.connection.reason === 'app_mismatch') {
        setConnectError(MISMATCH_COPY);
        setAppState({ status: 'idle' });
        setBotState({ status: 'idle' });
        setConnectionResult(null);
      } else if (res.connection.reason === 'incomplete') {
        // Quiet — waiting on the other token; no red
      } else {
        setConnectError('Could not connect — try again.');
      }
    } catch {
      setConnectError('Could not reach Slack to validate the token pair.');
    }
  }

  // Once both tokens are individually verified, validate the pair.
  useEffect(() => {
    if (appVerified && botVerified && !connecting && !connected) {
      setTimeout(() => void checkConnection(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appVerified, botVerified]);

  function scheduleValidateApp(token: string) {
    if (validateTimerRef.current) clearTimeout(validateTimerRef.current);
    const trimmed = token.trim();
    if (trimmed.length <= 20) return;
    // Validate immediately on wrong-type paste for fast routing hint; small delay otherwise.
    const delay = trimmed.startsWith('xoxb-') ? 300 : 600;
    validateTimerRef.current = setTimeout(() => void validateApp(trimmed), delay);
  }

  function scheduleValidateBot(token: string) {
    if (validateTimerRef.current) clearTimeout(validateTimerRef.current);
    const trimmed = token.trim();
    if (trimmed.length <= 20) return;
    const delay = trimmed.startsWith('xapp-') ? 300 : 600;
    validateTimerRef.current = setTimeout(() => void validateBot(trimmed), delay);
  }

  function handleAppTokenChange(value: string) {
    setAppToken(value);
    setAppState({ status: 'idle' });
    setConnectionResult(null);
    setConnectError(undefined);
    scheduleValidateApp(value);
  }

  function handleBotTokenChange(value: string) {
    setBotToken(value);
    setBotState({ status: 'idle' });
    setConnectionResult(null);
    setConnectError(undefined);
    scheduleValidateBot(value);
  }

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  function openInstall() {
    window.open(
      `/api/agents/${encodeURIComponent(agentId)}/slack/install`,
      '_blank',
      'noopener,noreferrer',
    );
    setStep1Done(true);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-5">
      {/* Step 1 */}
      <div className="flex gap-3">
        <StepCircle
          n={1}
          done={step1Done}
          active={true}
          onClick={
            step1Done
              ? () => {
                  setStep1Done(false);
                  setAppToken('');
                  setBotToken('');
                  setAppState({ status: 'idle' });
                  setBotState({ status: 'idle' });
                  setConnected(false);
                  setConnectError(undefined);
                  setConnectionResult(null);
                }
              : undefined
          }
        />
        <div className="flex-1">
          <div className="font-serif text-[14px] font-semibold text-text">
            Create &amp; install the Slack app
          </div>
          <div className="mt-1 font-serif text-[13px] leading-snug text-text-muted">
            <button
              onClick={openInstall}
              className="font-serif text-[13px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            >
              Create app
            </button>
            {' '}→ pick your Slack workspace → click <strong>Install</strong>.
            {' '}The manifest turns on Interactivity; if you reuse an older app, enable Interactivity in Slack.
          </div>
          {!step1Done && (
            <button
              onClick={() => setStep1Done(true)}
              className="mt-1.5 font-sans text-[11px] text-text-subtle underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted hover:decoration-text-muted/40"
            >
              Already have an app
            </button>
          )}
        </div>
      </div>

      {/* Step 2 — App-Level Token */}
      <div
        className={['flex gap-3', !step2Active ? 'pointer-events-none opacity-40' : ''].join(' ')}
      >
        <StepCircle
          n={2}
          done={step2Done}
          active={step2Active}
          onClick={
            step2Done
              ? () => {
                  setAppToken('');
                  setAppState({ status: 'idle' });
                  setConnected(false);
                  setConnectError(undefined);
                  setConnectionResult(null);
                }
              : undefined
          }
        />
        <div className="flex-1">
          <div className="font-serif text-[14px] font-semibold text-text">Copy App-Level Token</div>
          <div className="mt-1 font-serif text-[13px] leading-snug text-text-muted">
            Basic Information → App-Level Tokens → Generate → Add scope:{' '}
            <span className="font-mono text-[11px]">connections:write</span> → copy{' '}
            (<span className="font-mono text-[11px]">xapp-…</span>)
          </div>
          {step2Active && (
            <div className="mt-2">
              <input
                type="text"
                value={appToken}
                onChange={(e) => handleAppTokenChange(e.target.value)}
                onBlur={() => {
                  const t = appToken.trim();
                  if (t.length > 20 && appState.status === 'idle') void validateApp(t);
                }}
                placeholder="xapp-…"
                disabled={appVerified || connecting}
                className={[
                  'w-full rounded-sm border bg-muted/30 px-3 py-1.5 font-mono text-[12px] text-text placeholder:font-sans placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring',
                  appState.status === 'verified'
                    ? 'border-health-ok/50'
                    : appState.status === 'failed'
                      ? 'border-health-error/50'
                      : 'border-border',
                ].join(' ')}
              />
              <FieldStatus state={appState} field="app" />
            </div>
          )}
        </div>
      </div>

      {/* Step 3 — Bot Token */}
      <div
        className={['flex gap-3', !step3Active ? 'pointer-events-none opacity-40' : ''].join(' ')}
      >
        <StepCircle
          n={3}
          done={step3Done}
          active={step3Active}
          onClick={
            step3Done
              ? () => {
                  setBotToken('');
                  setBotState({ status: 'idle' });
                  setConnected(false);
                  setConnectError(undefined);
                  setConnectionResult(null);
                }
              : undefined
          }
        />
        <div className="flex-1">
          <div className="font-serif text-[14px] font-semibold text-text">Copy Bot Token</div>
          <div className="mt-1 font-serif text-[13px] leading-snug text-text-muted">
            OAuth &amp; Permissions → Install to Workspace → copy{' '}
            <strong>Bot User OAuth Token</strong>{' '}
            (<span className="font-mono text-[11px]">xoxb-…</span>)
          </div>
          {step3Active && (
            <div className="mt-2 space-y-3">
              <div>
                <input
                  type="text"
                  value={botToken}
                  onChange={(e) => handleBotTokenChange(e.target.value)}
                  onBlur={() => {
                    const t = botToken.trim();
                    if (t.length > 20 && botState.status === 'idle') void validateBot(t);
                  }}
                  placeholder="xoxb-…"
                  disabled={botVerified || connecting}
                  className={[
                    'w-full rounded-sm border bg-muted/30 px-3 py-1.5 font-mono text-[12px] text-text placeholder:font-sans placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring',
                    botState.status === 'verified'
                      ? 'border-health-ok/50'
                      : botState.status === 'failed'
                        ? 'border-health-error/50'
                        : 'border-border',
                  ].join(' ')}
                />
                <FieldStatus state={botState} field="bot" />
              </div>
              {connecting && (
                <div className="flex items-center gap-1.5 font-sans text-[12px] text-text-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Connecting…</span>
                </div>
              )}
              {connectError && (
                <div className="flex items-start gap-2">
                  <X className="mt-px h-3.5 w-3.5 shrink-0 text-health-error" />
                  <span className="font-sans text-[12px] text-health-error">{connectError}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Success card — persists from validation */}
      {connectionResult?.valid && (
        <ConnectionSuccess conn={connectionResult} />
      )}
    </div>
  );
}
