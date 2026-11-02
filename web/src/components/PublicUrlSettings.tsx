import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PublicUrl } from '@shared/public-url';
import { fetchPublicUrl, publicUrlKey, savePublicUrl } from '@/api/public-url';
import { Button } from '@/components/ui/button';

export default function PublicUrlSettings() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: publicUrlKey, queryFn: fetchPublicUrl, retry: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const value = draft ?? query.data?.publicUrl ?? '';
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = PublicUrl.safeParse(value);
    if (!parsed.success) {
      setError('Enter a public HTTPS address without a path, such as https://anima.example.com.');
      return;
    }
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      client.setQueryData(publicUrlKey, await savePublicUrl(parsed.data));
      await client.invalidateQueries({ queryKey: ['linear', 'setup'] });
      setDraft(null);
      setSaved(true);
    } catch {
      setError('Could not save the public address. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="public-url" aria-label="Anima public address" className="space-y-3">
      <h3 className="font-serif text-[17px] font-semibold text-text">Anima public address</h3>
      <p className="text-[13px] leading-relaxed text-text-muted">
        One HTTPS address for this Anima instance. Integrations use it to generate their callback
        and webhook URLs.
      </p>
      {query.isPending && (
        <p role="status" className="text-sm text-text-muted">
          Loading settings…
        </p>
      )}
      {query.isError && (
        <p role="alert" className="text-sm text-health-error">
          Could not read the public address.{' '}
          <button
            className="min-h-[44px] underline md:min-h-[32px]"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {query.data && (
        <form onSubmit={(event) => void save(event)} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-muted">Public URL</span>
            <input
              required
              type="url"
              value={value}
              disabled={busy}
              placeholder="https://anima.example.com"
              onChange={(event) => {
                setDraft(event.target.value);
                setSaved(false);
              }}
              className="h-[44px] w-full min-w-0 rounded-sm border border-border-soft bg-surface px-3 font-mono text-[13px] text-text outline-none focus-visible:border-accent disabled:opacity-60"
            />
          </label>
          <p className="text-[12px] leading-relaxed text-text-muted">
            Configure HTTPS forwarding separately. Saving this address does not create a tunnel or
            expose the dashboard. If you change it, update the URLs registered in existing apps too.
          </p>
          {error && (
            <p role="alert" className="text-sm text-health-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || query.isError} className="min-h-[44px]">
            {busy ? 'Saving…' : 'Save public address'}
          </Button>
          {saved && (
            <p role="status" className="text-sm text-text-muted">
              Public address saved. Return to the connection setup to continue.
            </p>
          )}
        </form>
      )}
    </section>
  );
}
