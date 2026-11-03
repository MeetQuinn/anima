import { useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
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
  autoFocus = false,
}: {
  initial?: string;
  onSaved?: (publicUrl: string) => void;
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
    <form noValidate onSubmit={(event) => void save(event)} className="space-y-2">
      <label htmlFor={inputId} className="block font-sans text-[12px] text-text-muted">
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
          className="h-11 w-full min-w-0 rounded-sm border border-border-soft bg-surface-raised px-3 font-mono text-[13px] text-text outline-none placeholder:font-sans placeholder:text-text-subtle focus-visible:border-accent aria-invalid:border-health-error/60 disabled:opacity-60 md:h-10 md:flex-1"
        />
        <Button type="submit" disabled={busy || unchanged || !value.trim()} className="h-11 px-5 text-[13px] md:h-10">
          {busy ? 'Saving…' : 'Save'}
        </Button>
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
      Forward the whole address to this dashboard, for example with a Cloudflare Tunnel to the address you
      open it at on this machine. If a sign-in gateway such as Cloudflare Access protects it, let{' '}
      <span className="font-mono text-[12px] text-text">/webhooks/</span> through: Linear can’t sign in.
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
 * Whether the saved address reaches this Anima, the way Linear will reach it.
 * Runs when shown and after every save; the result is never assumed.
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
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Checking that Linear can reach this address…
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
  if (result.reachable && result.hostRecognized === false && !result.passwordSet) {
    return (
      <div role="alert" className="flex gap-2.5 rounded-sm border border-health-error/25 bg-health-error-soft/50 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-health-error" aria-hidden="true" />
        <div className="min-w-0 space-y-0.5 font-sans text-[12px] leading-relaxed">
          <p className="font-medium text-health-error">Reachable, and the dashboard is open there</p>
          <p className="text-text-muted">
            Your forwarding replaces the address in the Host header, so Anima can’t tell requests through it
            from requests on this machine. Set a dashboard password now:{' '}
            <code className="break-all font-mono text-[11px]">{SET_PASSWORD_COMMAND}</code>. Or keep the
            original Host header in the tunnel. {again}
          </p>
        </div>
      </div>
    );
  }
  if (!result.reachable) {
    return (
      <div role="alert" className="flex gap-2.5 rounded-sm border border-health-error/25 bg-health-error-soft/50 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-health-error" aria-hidden="true" />
        <div className="min-w-0 space-y-0.5 font-sans text-[12px] leading-relaxed">
          <p className="font-medium text-health-error">Not reachable yet</p>
          <p className="text-text-muted">
            {failureText(result)} {again}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div role="status" className="space-y-1 font-sans text-[12px] leading-relaxed">
      <p className="flex flex-wrap items-center gap-x-1.5 text-health-ok">
        <Check className="size-3.5" aria-hidden="true" /> Reachable. Linear can deliver events here.
        <span className="text-text-subtle">{again}</span>
      </p>
      {result.passwordSet ? (
        <p className="text-text-subtle">The dashboard asks for its password at this address.</p>
      ) : (
        <p className="max-w-prose text-text-subtle">
          The dashboard has no password, so this address only accepts Linear events. To open the dashboard
          here too, set a password on this machine:{' '}
          <code className="break-all font-mono text-[11px] text-text-muted">{SET_PASSWORD_COMMAND}</code>
        </p>
      )}
    </div>
  );
}

export default function PublicUrlSettings() {
  const query = useQuery({ queryKey: publicUrlKey, queryFn: fetchPublicUrl, retry: false });
  return (
    <section id="public-url" aria-labelledby="public-url-title" className="space-y-4">
      <div className="space-y-1">
        <h3 id="public-url-title" className="font-serif text-[17px] font-semibold text-text">
          Public address
        </h3>
        <p className="max-w-prose font-serif text-[13px] leading-relaxed text-text-muted">
          One HTTPS address for this Anima. Integrations like Linear build their webhook and callback URLs
          from it.
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
        <PublicAddressForm initial={query.data.publicUrl} />
      )}
      {query.data?.publicUrl && <PublicAddressCheck publicUrl={query.data.publicUrl} />}
      {query.data && <PublicAddressGuidance />}
      {query.data?.publicUrl && (
        <p className="max-w-prose font-sans text-[12px] leading-relaxed text-text-subtle">
          If you change the address, also update the webhook and callback URLs in Linear apps you
          already created.
        </p>
      )}
    </section>
  );
}
