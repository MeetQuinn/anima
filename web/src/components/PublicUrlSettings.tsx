import { useId, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { PublicUrl } from '@shared/public-url';
import { fetchPublicUrl, publicUrlKey, savePublicUrl } from '@/api/public-url';
import { fetchLinearSetup } from '@/api/linear';
import { Button } from '@/components/ui/button';
import { linearSetupKey } from '@/components/LinearWebhookSettings';
import { LinearForwardingRoutes } from '@/components/LinearForwardingRoutes';

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

export default function PublicUrlSettings() {
  const query = useQuery({ queryKey: publicUrlKey, queryFn: fetchPublicUrl, retry: false });
  const setup = useQuery({ queryKey: linearSetupKey, queryFn: fetchLinearSetup, retry: false });
  return (
    <section id="public-url" aria-labelledby="public-url-title" className="space-y-4">
      <div className="space-y-1">
        <h3 id="public-url-title" className="font-serif text-[17px] font-semibold text-text">
          Public address
        </h3>
        <p className="max-w-prose font-serif text-[13px] leading-relaxed text-text-muted">
          The HTTPS address that reaches this machine. Integrations like Linear build their webhook and
          sign-in URLs from it.
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
      {query.data?.publicUrl && setup.data && (
        <LinearForwardingRoutes setup={{ ...setup.data, publicUrl: query.data.publicUrl }} />
      )}
      {query.data?.publicUrl && (
        <p className="max-w-prose font-sans text-[12px] leading-relaxed text-text-subtle">
          If you change the address, also update the webhook and callback URLs in Linear apps you
          already created.
        </p>
      )}
    </section>
  );
}
