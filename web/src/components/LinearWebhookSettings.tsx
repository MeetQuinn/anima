import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { LinearSetup } from '@shared/linear-setup';
import { LinearSetupRequest } from '@shared/linear-setup';
import { fetchLinearSetup, saveLinearSetup } from '@/api/linear';
import { Button } from '@/components/ui/button';

export const linearSetupKey = ['linear', 'setup'] as const;
export const linearInputClass =
  'h-[44px] w-full min-w-0 rounded-sm border border-border-soft bg-surface px-3 font-mono text-[13px] text-text outline-none focus-visible:border-accent disabled:cursor-not-allowed disabled:bg-surface-elevated disabled:text-text-muted disabled:opacity-60';

export default function LinearWebhookSettings({
  onSaved,
  onBusy,
}: {
  onSaved?: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [saved, setSaved] = useState(false);
  const query = useQuery({ queryKey: linearSetupKey, queryFn: fetchLinearSetup, retry: false });
  return (
    <section className="space-y-3" aria-label="Linear webhook settings">
      <h3 className="font-serif text-[17px] font-semibold text-text">Linear webhook</h3>
      <p className="font-sans text-[13px] leading-relaxed text-text-muted">
        Set up a public HTTPS address once for this machine. Every agent uses it to receive requests
        from Linear. Anima does not create the tunnel or reverse proxy.
      </p>
      {query.isPending && (
        <p role="status" className="text-sm text-text-muted">
          Loading settings…
        </p>
      )}
      {query.isError && (
        <p role="alert" className="text-sm text-health-error">
          Could not read webhook settings.{' '}
          <button
            type="button"
            className="min-h-[44px] underline md:min-h-[32px]"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {query.data && (
        <WebhookForm
          key={JSON.stringify(query.data)}
          data={query.data}
          onSaved={() => {
            setSaved(true);
            onSaved?.();
          }}
          onBusy={onBusy}
        />
      )}
      {saved && (
        <p role="status" className="text-sm text-text-muted">
          Webhook settings saved.
        </p>
      )}
    </section>
  );
}

function WebhookForm({
  data,
  onSaved,
  onBusy,
}: {
  data: LinearSetup;
  onSaved?: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const client = useQueryClient();
  const [url, setUrl] = useState(data.webhookUrl ?? '');
  const [host, setHost] = useState(data.listener.host);
  const [port, setPort] = useState(String(data.listener.port));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = LinearSetupRequest.safeParse({
      webhookUrl: url,
      listener: { host, port: Number(port) },
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the address and port.');
      return;
    }
    setBusy(true);
    onBusy?.(true);
    setError('');
    try {
      const result = await saveLinearSetup(parsed.data);
      client.setQueryData(linearSetupKey, result);
      void client.invalidateQueries({ queryKey: ['agent'] });
      onSaved?.();
    } catch {
      setError(
        'Could not save. Check the HTTPS address and use a port other than the dashboard port. Installed agents must keep their current listener.',
      );
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)} className="space-y-4">
      <label className="block">
        <span className="mb-1 block font-sans text-[12px] text-text-muted">Public webhook URL</span>
        <input
          required
          type="url"
          placeholder="https://anima.example.com/webhook"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
          }}
          disabled={busy}
          className={linearInputClass}
        />
      </label>
      <p className="break-words font-sans text-[12px] leading-relaxed text-text-muted">
        Forward this address to{' '}
        <span className="font-mono">
          {host.includes(':') ? `[${host}]` : host}:{port}/webhook
        </span>{' '}
        on this machine.
        {data.webhookUrl &&
          ' If you change it, update the webhook URL in existing Linear apps too.'}
      </p>
      <details>
        <summary className="cursor-pointer py-2 font-sans text-[12px] text-text-muted">
          Advanced listener settings
        </summary>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
          <label>
            <span className="mb-1 block text-[12px] text-text-muted">Bind address</span>
            <input
              required
              value={host}
              disabled={busy || data.listenerLocked}
              onChange={(e) => setHost(e.target.value)}
              className={linearInputClass}
            />
          </label>
          <label>
            <span className="mb-1 block text-[12px] text-text-muted">Port</span>
            <input
              required
              type="number"
              min="1024"
              max="65535"
              value={port}
              disabled={busy || data.listenerLocked}
              onChange={(e) => setPort(e.target.value)}
              className={linearInputClass}
            />
          </label>
        </div>
        {data.listenerLocked && (
          <p className="mt-2 text-[12px] text-text-muted">
            An installed app or an authorization in progress uses this listener.
          </p>
        )}
      </details>
      {error && (
        <p role="alert" className="text-sm text-health-error">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" className="min-h-[44px]" disabled={busy}>
          {busy ? 'Saving…' : 'Save webhook settings'}
        </Button>
      </div>
    </form>
  );
}
