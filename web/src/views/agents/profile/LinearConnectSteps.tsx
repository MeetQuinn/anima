import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, ExternalLink, Loader2 } from 'lucide-react';
import { LinearInstallRequest } from '@shared/linear';
import {
  defaultLinearAppName,
  linearAppCreationUrl,
  linearAppIconUrl,
  LinearAppName,
  type LinearSetup,
} from '@shared/linear-setup';
import { Button, buttonVariants } from '@/components/ui/button';

type StepState = 'done' | 'active' | 'upcoming';

/**
 * Per-agent Linear connection: create (or reuse) an app, paste its three
 * credentials, authorize. All three steps stay visible so the whole job is
 * readable at a glance; later steps unlock as earlier ones finish. Machine
 * plumbing (public address, forwarding) is not repeated here.
 */
export function LinearConnectSteps({
  agentName,
  avatarUrl,
  setup,
  busy,
  disabled,
  retrying = false,
  error: serverError = '',
  onInstall,
}: {
  agentName: string;
  /** The agent's avatar; used as the app icon when Linear can fetch it publicly. */
  avatarUrl?: string;
  setup: LinearSetup;
  busy: boolean;
  disabled: boolean;
  /** A previous authorization failed: the app already exists, start at credentials. */
  retrying?: boolean;
  /** Why the last attempt to start authorization failed, from the parent. */
  error?: string;
  onInstall: (input: LinearInstallRequest) => Promise<void>;
}) {
  const [appReady, setAppReady] = useState(retrying);
  const [reusedApp, setReusedApp] = useState(retrying);
  const [name, setName] = useState(() => defaultLinearAppName(agentName));
  const [renaming, setRenaming] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [error, setError] = useState('');
  const ids = useId();
  const validName = LinearAppName.safeParse(name).success;
  const callback = setup.callbackUrl ?? '';
  const iconUrl = linearAppIconUrl(avatarUrl);
  let creationUrl = '';
  if (setup.webhookUrl && validName) {
    try {
      creationUrl = linearAppCreationUrl({ name, callbackUrl: callback, webhookUrl: setup.webhookUrl, iconUrl });
    } catch {
      /* An invalid name keeps the link hidden; the rename field explains why. */
    }
  }
  const credentialsReady = Boolean(clientId.trim() && clientSecret.trim() && signingSecret.trim());
  const clearSecrets = () => {
    setClientSecret('');
    setSigningSecret('');
  };

  async function install(event: FormEvent) {
    event.preventDefault();
    const parsed = LinearInstallRequest.safeParse({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      signingSecret: signingSecret.trim(),
      callbackUrl: callback,
    });
    if (!parsed.success) {
      setError('Check the Client ID, Client secret and Webhook signing secret.');
      return;
    }
    setError('');
    try {
      await onInstall(parsed.data);
    } finally {
      clearSecrets();
    }
  }

  const step1: StepState = appReady ? 'done' : 'active';
  const step2: StepState = !appReady ? 'upcoming' : credentialsReady ? 'done' : 'active';
  const step3: StepState = appReady && credentialsReady ? 'active' : 'upcoming';

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h3 className="font-serif text-[20px] font-semibold leading-tight text-text">
          Connect {agentName} to Linear
        </h3>
        <p className="font-serif text-[14px] leading-relaxed text-text-muted">
          {agentName} gets its own Linear app, so your team can mention it or delegate issues to it.
        </p>
      </header>

      <ol aria-label="Connection steps" className="space-y-0">
        <Step n={1} state={step1} title={reusedApp ? 'Use your Linear app' : 'Create the app in Linear'}>
          {appReady ? (
            <p className="font-serif text-[13px] text-text-muted">
              {reusedApp ? 'Using an app you already created.' : 'Opened in Linear.'}{' '}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setAppReady(false);
                  setReusedApp(false);
                  clearSecrets();
                }}
                className="inline-flex min-h-11 items-center font-sans text-[12px] text-text-subtle underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted md:min-h-0"
              >
                Change
              </button>
            </p>
          ) : (
            <div className="space-y-3">
              <p className="font-serif text-[13px] leading-relaxed text-text-muted">
                Linear opens with everything filled in. Check it and click <strong className="font-semibold text-text">Create</strong>.
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {creationUrl && !disabled ? (
                  <a
                    href={creationUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setAppReady(true)}
                    className={buttonVariants({ className: 'h-11 gap-2 px-4 text-[13px] md:h-10' })}
                  >
                    Create app in Linear <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                ) : (
                  <span aria-disabled="true" className={buttonVariants({ className: 'h-11 px-4 text-[13px] opacity-50 md:h-10' })}>
                    Create app in Linear
                  </span>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setReusedApp(true);
                    setAppReady(true);
                  }}
                  className="inline-flex min-h-11 items-center font-sans text-[13px] text-text-muted underline decoration-text-subtle/50 underline-offset-2 hover:text-text disabled:opacity-50 md:min-h-8"
                >
                  I already have one
                </button>
              </div>
              {renaming || !validName ? (
                <div className="max-w-sm space-y-1">
                  <label htmlFor={`${ids}-name`} className="block font-sans text-[12px] text-text-muted">
                    App name in Linear
                  </label>
                  <input
                    id={`${ids}-name`}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    aria-invalid={!validName || undefined}
                    aria-describedby={!validName ? `${ids}-name-error` : undefined}
                    className={inputClass}
                  />
                  {!validName && (
                    <p id={`${ids}-name-error`} role="alert" className="font-sans text-[12px] text-health-error">
                      Use 2–80 characters, without “Linear” or a URL.
                    </p>
                  )}
                </div>
              ) : (
                <p className="flex flex-wrap items-center gap-x-1.5 font-sans text-[12px] text-text-subtle">
                  {iconUrl && <img src={iconUrl} alt="" className="size-5 shrink-0 rounded-full object-cover" />}
                  <span>
                    Named <span className="text-text-muted">{name}</span> in Linear
                    {iconUrl ? ', with this avatar.' : '.'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRenaming(true)}
                    className="inline-flex min-h-11 items-center underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted md:min-h-0"
                  >
                    Rename
                  </button>
                </p>
              )}
            </div>
          )}
        </Step>

        <form id={`${ids}-form`} onSubmit={(event) => void install(event)} className="contents">
          <Step n={2} state={step2} title="Copy its credentials">
            {appReady && (
              <div className="space-y-3">
                <p className="font-serif text-[13px] leading-relaxed text-text-muted">
                  {retrying
                    ? 'Enter them again from your app’s page in Linear. The secrets are not kept after a failed attempt.'
                    : 'All three are on the app’s page in Linear, right after you create it.'}
                </p>
                <div className="space-y-3">
                  <div className="min-w-0 space-y-1">
                    <label htmlFor={`${ids}-client`} className="block font-sans text-[12px] text-text-muted">
                      Client ID
                    </label>
                    <input
                      id={`${ids}-client`}
                      required
                      disabled={busy}
                      value={clientId}
                      onChange={(event) => setClientId(event.target.value)}
                      {...notACredentialField}
                      className={inputClass}
                    />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <label htmlFor={`${ids}-client-secret`} className="block font-sans text-[12px] text-text-muted">
                      Client secret
                    </label>
                    <input
                      id={`${ids}-client-secret`}
                      required
                      disabled={busy}
                      value={clientSecret}
                      onChange={(event) => setClientSecret(event.target.value)}
                      {...notACredentialField}
                      className={inputClass}
                    />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <label htmlFor={`${ids}-secret`} className="block font-sans text-[12px] text-text-muted">
                      Webhook signing secret
                    </label>
                    <input
                      id={`${ids}-secret`}
                      required
                      disabled={busy}
                      value={signingSecret}
                      onChange={(event) => setSigningSecret(event.target.value)}
                      {...notACredentialField}
                      className={inputClass}
                    />
                  </div>
                </div>
                <p className="font-sans text-[11px] text-text-subtle">
                  Both secrets are stored on this machine and never shown again.
                </p>
              </div>
            )}
          </Step>

          <Step n={3} state={step3} title="Authorize" last>
            {appReady && (
              <div className="space-y-3">
                <p className="font-serif text-[13px] leading-relaxed text-text-muted">
                  Linear asks which teams {agentName} can access. Choose all available teams for
                  workspace-wide work; workspace admins can change this later in Linear.
                </p>
                {(error || serverError) && (
                  <p role="alert" className="font-sans text-[12px] leading-relaxed text-health-error">
                    {error || serverError}
                  </p>
                )}
                <Button
                  type="submit"
                  disabled={busy || disabled || !credentialsReady}
                  className="h-11 gap-2 px-4 text-[13px] md:h-10"
                >
                  {busy ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Opening Linear…
                    </>
                  ) : (
                    <>
                      Authorize in Linear <ArrowRight className="size-3.5" aria-hidden="true" />
                    </>
                  )}
                </Button>
              </div>
            )}
          </Step>
        </form>
      </ol>
    </div>
  );
}

/**
 * These values are pasted from Linear, not remembered by the user. A password
 * input makes browsers offer saved or generated passwords whatever
 * `autocomplete` says, so secrets are plain text fields (visible while
 * pasting, cleared on submit) and password-manager extensions are told to
 * skip them.
 */
export const notACredentialField = {
  type: 'text',
  autoComplete: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': true,
  'data-form-type': 'other',
} as const;

export const inputClass =
  'h-11 w-full min-w-0 rounded-sm border border-border-soft bg-surface-raised px-3 font-mono text-[13px] text-text outline-none placeholder:font-sans placeholder:text-text-subtle focus-visible:border-accent aria-invalid:border-health-error/60 disabled:cursor-not-allowed disabled:opacity-60 md:h-10';

function Step({
  n,
  state,
  title,
  last = false,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      aria-current={state === 'active' ? 'step' : undefined}
      className={`relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3.5 ${last ? '' : 'pb-6'}`}
    >
      {!last && (
        <span
          aria-hidden="true"
          className={`absolute bottom-0 left-[0.75rem] top-7 w-px -translate-x-1/2 ${state === 'done' ? 'bg-health-ok/40' : 'bg-border-soft'}`}
        />
      )}
      <span
        aria-hidden="true"
        className={[
          'relative mt-px flex size-6 items-center justify-center rounded-full border font-sans text-[11px] font-semibold',
          state === 'done'
            ? 'border-health-ok bg-health-ok-soft text-health-ok'
            : state === 'active'
              ? 'border-text bg-surface text-text'
              : 'border-border-soft bg-surface text-text-subtle',
        ].join(' ')}
      >
        {state === 'done' ? <Check className="size-3.5" /> : n}
      </span>
      <div className="min-w-0 space-y-2">
        <h4
          className={`font-serif text-[15px] font-semibold leading-6 ${state === 'upcoming' ? 'text-text-subtle' : 'text-text'}`}
        >
          <span className="sr-only">Step {n}{state === 'done' ? ', done' : ''}: </span>
          {title}
        </h4>
        {children}
      </div>
    </li>
  );
}
