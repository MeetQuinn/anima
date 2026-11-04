import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Loader2, Pencil, ShieldAlert } from 'lucide-react';
import { PublicUrl, type PublicUrlCheck } from '@shared/public-url';
import { checkPublicUrl, fetchPublicUrl, publicUrlCheckKey, publicUrlKey, savePublicUrl } from '@/api/public-url';
import { linearSetupKey } from '@/api/linear';
import { Button } from '@/components/ui/button';

/**
 * One input + Save for the instance-wide public address. Used on the Server
 * page and inline in the Linear dialog when no address is set yet; both save
 * the same global setting.
 */
export function PublicAddressForm({
  initial,
  onSaved,
  onCancel,
  autoFocus = false,
}: {
  initial?: string;
  onSaved?: (publicUrl: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const client = useQueryClient();
  const [value, setValue] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const unchanged = Boolean(initial) && value.trim() === initial;
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = PublicUrl.safeParse(value);
    if (!parsed.success) {
      setError('Use an HTTPS address with no path, like https://anima.example.com.');
      return;
    }
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const result = await savePublicUrl(parsed.data);
      client.setQueryData(publicUrlKey, result);
      await client.invalidateQueries({ queryKey: linearSetupKey });
      await client.invalidateQueries({ queryKey: publicUrlCheckKey });
      setValue(result.publicUrl ?? parsed.data);
      setSaved(true);
      onSaved?.(result.publicUrl ?? parsed.data);
    } catch {
      setError('Could not save the address. Try again.');
    } finally {
      setBusy(false);
    }
  }
  const inputId = useId();
  const errorId = `${inputId}-error`;
  return (
    <form
      noValidate
      onSubmit={(event) => void save(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onCancel && !busy) {
          event.preventDefault();
          onCancel();
        }
      }}
      className="space-y-2"
    >
      <label htmlFor={inputId} className="sr-only">
        Public address
      </label>
      <div className="flex flex-col gap-2 md:flex-row">
        <input
          id={inputId}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={value}
          disabled={busy}
          placeholder="https://anima.example.com"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setSaved(false);
            setError('');
          }}
          className="h-[44px] w-full min-w-0 rounded-sm border border-border-soft bg-surface-raised px-3 font-mono text-[13px] text-text outline-none placeholder:font-sans placeholder:text-text-subtle focus-visible:border-accent aria-invalid:border-health-error/60 disabled:opacity-60 md:h-10 md:flex-1"
        />
        <div className="flex shrink-0 items-center gap-2">
          <Button type="submit" disabled={busy || unchanged || !value.trim()} className="h-[44px] flex-1 px-5 md:h-10 md:flex-none">
            {busy ? 'Saving…' : 'Save'}
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel} className="h-[44px] flex-1 px-4 md:h-10 md:flex-none">
              Cancel
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p id={errorId} role="alert" className="font-sans text-[12px] text-health-error">
          {error}
        </p>
      )}
      {saved && !error && (
        <p role="status" className="flex items-center gap-1.5 font-sans text-[12px] text-health-ok">
          <Check className="size-3.5" aria-hidden="true" /> Saved for all agents
        </p>
      )}
    </form>
  );
}

export const SET_PASSWORD_COMMAND = 'npx -y @meetquinn/animactl@latest dashboard-auth set --password-stdin';

/** How to point the address here. One forwarding target, nothing per integration. */
export function PublicAddressGuidance() {
  return (
    <p className="max-w-prose font-serif text-[13px] leading-relaxed text-text-muted">
      Forward the whole address to this dashboard, for example with a Cloudflare Tunnel. Protect it with
      a sign-in gateway such as Cloudflare Access or a dashboard password. With a gateway, let{' '}
      <span className="font-mono text-[12px] text-text">/webhooks/</span> through: Linear can’t sign in. Linear
      apps created before this version post to <span className="font-mono text-[12px] text-text">/webhook</span>;
      let that through too, or change their webhook URL.
    </p>
  );
}

function failureText(check: PublicUrlCheck): string {
  const http = check.status ? ` (HTTP ${check.status})` : '';
  switch (check.failure) {
    case 'gateway':
      return `A sign-in page or access rule answered${http}. Let /webhooks/ through it, for example with a Cloudflare Access bypass for that path.`;
    case 'elsewhere':
      return `Something answered${http}, but not this Anima. Forward the whole address to this dashboard.`;
    case 'timeout':
      return 'The address didn’t answer within 5 seconds. Check that your tunnel is running.';
    case 'not_configured':
      return 'No public address is saved yet.';
    default:
      return `Anima couldn’t reach itself at this address${http}. Check that your tunnel is running and forwards to this dashboard.`;
  }
}

/**
 * Shown when the check opened the dashboard through the address without signing
 * in. A warning only: Anima serves the address either way.
 */
function OpenDashboardWarning() {
  return (
    <div role="alert" className="flex gap-2.5 rounded-sm border border-health-error/50 bg-health-error-soft px-3 py-3">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-health-error" aria-hidden="true" />
      <div className="min-w-0 space-y-1 font-sans text-[12px] leading-relaxed">
        <p className="text-[13px] font-semibold text-health-error">Anyone can open the dashboard at this address</p>
        <p className="max-w-prose text-text">
          Anima opened it through this address without signing in. Whoever has the address can use the
          dashboard, including its agents and settings.
        </p>
        <p className="max-w-prose text-text-muted">
          Put a sign-in gateway such as Cloudflare Access in front of it and let{' '}
          <span className="font-mono text-[11px] text-text">/webhooks/</span> through, or set a dashboard password
          on this machine:
        </p>
        <code className="block break-words font-mono text-[11px] text-text">{SET_PASSWORD_COMMAND}</code>
      </div>
    </div>
  );
}

/**
 * Something in front asked for credentials (401) or refused (403). A redirect alone
 * is not that: an ordinary host or path redirect answers 3xx too.
 */
const asksFirst = (status: number) => status === 401 || status === 403;
const redirected = (status: number) => status >= 300 && status < 400;

/**
 * What the check saw at a reachable address that did not open the dashboard. Only
 * a 401 or 403 is reported as something asking first; any other answer, such as a
 * redirect, an error or an unexpected page, leaves the question open.
 */
function protection(check: PublicUrlCheck) {
  if (check.passwordSet) return 'Dashboard password enabled.';
  const status = check.dashboard?.status;
  const seen = status === undefined ? undefined : redirected(status) ? `was redirected (HTTP ${status})` : `got HTTP ${status}`;
  if (status !== undefined && asksFirst(status))
    return `No dashboard password. The address asked for sign-in or refused access (HTTP ${status}).`;
  return (
    <>
      No dashboard password. {seen ? `The dashboard check ${seen}; access protection is unconfirmed.` : 'Access protection is unconfirmed.'}{' '}
      Use a sign-in gateway or set a dashboard password.
    </>
  );
}

/**
 * Whether requests through the saved address arrive at this dashboard, and whether
 * the dashboard opens there without signing in. It does not cover the runtime's
 * receiver or the app in Linear; "Last event" on a connected agent is that
 * evidence. Runs when shown and after every save.
 */
export function PublicAddressCheck({ publicUrl }: { publicUrl: string }) {
  const check = useQuery({
    queryKey: [...publicUrlCheckKey, publicUrl],
    queryFn: checkPublicUrl,
    retry: false,
    staleTime: 60_000,
  });
  const again = (
    <button
      type="button"
      disabled={check.isFetching}
      onClick={() => void check.refetch()}
      className="inline-flex min-h-11 items-center underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted disabled:opacity-50 md:min-h-0"
    >
      Check again
    </button>
  );
  if (check.isPending || (check.isFetching && !check.data?.reachable)) {
    return (
      <p role="status" className="flex items-center gap-1.5 font-sans text-[12px] text-text-muted">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Checking the address…
      </p>
    );
  }
  if (check.isError || !check.data) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-x-1.5 font-sans text-[12px] text-health-error">
        Couldn’t run the check. {again}
      </p>
    );
  }
  const result = check.data;
  const open = result.dashboard?.open === true;
  return (
    <div className="space-y-2.5">
      {result.reachable ? (
        <div role="status" className="space-y-1 font-sans text-[12px] leading-relaxed">
          <p className="flex flex-wrap items-center gap-x-1.5 text-health-ok">
            <Check className="size-3.5" aria-hidden="true" /> Address reaches this Anima.
            <span className="text-text-subtle">{again}</span>
          </p>
          {!open && <p className="max-w-prose text-text-subtle">{protection(result)}</p>}
        </div>
      ) : (
        <div role="alert" className="flex gap-2.5 rounded-sm border border-health-error/25 bg-health-error-soft/50 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-health-error" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5 font-sans text-[12px] leading-relaxed">
            <p className="font-medium text-health-error">Not reachable yet</p>
            <p className="text-text-muted">
              {failureText(result)} {again}
            </p>
          </div>
        </div>
      )}
      {open && <OpenDashboardWarning />}
    </div>
  );
}

export default function PublicUrlSettings() {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!editing && returnFocus.current) {
      editButton.current?.focus();
      returnFocus.current = false;
    }
  }, [editing]);
  const query = useQuery({ queryKey: publicUrlKey, queryFn: fetchPublicUrl, retry: false });
  return (
    <section id="public-url" aria-labelledby="public-url-title" className="space-y-4">
      <div className="space-y-1">
        <h3 id="public-url-title" className="font-serif text-[17px] font-semibold text-text">
          Public address
        </h3>
        <p className="max-w-prose font-serif text-[13px] leading-relaxed text-text-muted">
          Shared by all agents for integration webhooks and callbacks.
        </p>
      </div>
      {query.isPending && (
        <p role="status" className="font-sans text-[13px] text-text-muted">
          Loading…
        </p>
      )}
      {query.isError && (
        <p role="alert" className="font-sans text-[13px] text-health-error">
          Could not read the public address.{' '}
          <button
            type="button"
            className="min-h-11 px-1 underline md:min-h-8"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {query.data && (
        query.data.publicUrl && !editing ? (
          <div className="flex items-start justify-between gap-3">
            <code className="min-w-0 break-all py-2 font-mono text-[13px] leading-5 text-text">
              {query.data.publicUrl}
            </code>
            <Button
              ref={editButton}
              variant="outline"
              aria-label="Edit public address"
              onClick={() => {
                setSaved(false);
                returnFocus.current = true;
                setEditing(true);
              }}
              className="h-[44px] gap-1.5 px-3 md:h-9"
            >
              <Pencil className="size-3.5" aria-hidden="true" /> Edit
            </Button>
          </div>
        ) : (
          <PublicAddressForm
            initial={query.data.publicUrl}
            autoFocus={editing}
            onCancel={query.data.publicUrl ? () => setEditing(false) : undefined}
            onSaved={() => {
              setSaved(true);
              setEditing(false);
            }}
          />
        )
      )}
      {query.data?.publicUrl && editing && (
        <p className="max-w-prose font-sans text-[12px] leading-relaxed text-text-subtle">
          If you change this address, update existing Linear apps’ webhook and callback URLs too.
        </p>
      )}
      {saved && !editing && (
        <p role="status" className="flex items-center gap-1.5 font-sans text-[12px] text-health-ok">
          <Check className="size-3.5" aria-hidden="true" /> Saved for all agents
        </p>
      )}
      {query.data?.publicUrl && <PublicAddressCheck publicUrl={query.data.publicUrl} />}
      {query.data && (
        <details open={!query.data.publicUrl} className="group border-t border-border-soft pt-3">
          <summary className="min-h-[44px] cursor-pointer py-3 font-sans text-[12px] md:min-h-0 md:py-1 text-text-muted hover:text-text">
            Setup and access protection
          </summary>
          <div className="mt-2 space-y-3">
            <PublicAddressGuidance />
            <div className="space-y-1 font-sans text-[12px] text-text-muted">
              <p>Set a dashboard password on this machine:</p>
              <code className="block break-words font-mono text-[11px]">{SET_PASSWORD_COMMAND}</code>
            </div>
          </div>
        </details>
      )}

    </section>
  );
}
