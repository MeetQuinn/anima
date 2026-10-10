import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { fetchLinearStatus, installLinear, removeLinear } from '@/api/linear';
import { refreshAgentData } from '@/api/agents';
import { Button } from '@/components/ui/button';
import { Section } from './Primitives';

export function LinearSection({ agentId }: { agentId: string }) {
  const status = useQuery({ queryKey: ['agent', agentId, 'linear'], queryFn: () => fetchLinearStatus(agentId), refetchInterval: 5000, retry: false });
  const [formOpen, setFormOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [callback, setCallback] = useState(`${window.location.origin}/api/linear/oauth/callback`);
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('14175');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const data = status.data;
  useEffect(() => { if (data?.state === 'connected' || data?.state === 'revoked') refreshAgentData(agentId); }, [data?.state, agentId]);
  const connected = data?.state === 'connected';
  const configured = Boolean(data && data.state !== 'not_configured');

  async function install(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setAuthorizationUrl('');
    try {
      const result = await installLinear(agentId, { clientId, signingSecret: secret, callbackUrl: callback,
        listener: { host: data?.listener?.host ?? host, port: data?.listener?.port ?? Number(port) } });
      setSecret('');
      setAuthorizationUrl(result.authorizationUrl);
      await status.refetch();
    } catch { setError('Installation could not start. Check the client ID, callback URL, signing secret and listener settings.'); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError('');
    try { await removeLinear(agentId); setAuthorizationUrl(''); setSecret(''); setFormOpen(false); await status.refetch(); refreshAgentData(agentId); }
    catch { setError('Removal failed. Refresh the settings before trying again.'); }
    finally { setBusy(false); }
  }
  const inputClass = 'h-11 w-full min-w-0 rounded-sm border border-border-soft bg-surface px-3 font-mono text-[13px] text-text outline-none focus-visible:border-accent';

  return <Section title="Linear">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="font-serif text-[15px] text-text">{connected ? 'App installed' : data?.state === 'revoked' ? 'Authorization revoked' : data?.state === 'installing' ? 'Awaiting authorization' : 'Give this agent a presence in Linear.'}</p>
      {!configured && <Button variant="outline" onClick={() => setFormOpen(!formOpen)} aria-expanded={formOpen} disabled={status.isPending || status.isError}>{formOpen ? 'Close setup' : 'Add Linear app'}</Button>}
      {configured && <Button variant="outline" onClick={() => void remove()} disabled={busy}>{busy ? 'Removing…' : 'Remove connection'}</Button>}
    </div>
    {status.isPending && <p role="status" className="mt-3 font-sans text-[13px] text-text-muted">Loading Linear settings…</p>}
    {status.isError && <p role="alert" className="mt-3 font-sans text-[13px] text-health-error">Linear settings could not be read. <button type="button" className="underline" onClick={() => void status.refetch()}>Retry</button></p>}
    {data && configured && <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-border-soft pt-4 sm:grid-cols-2">
      <div className="min-w-0"><dt className="chrome text-[11px] text-text-muted">Client ID</dt><dd className="mt-1 break-all font-mono text-[12px] text-text">{data.clientId}</dd></div>
      <div><dt className="chrome text-[11px] text-text-muted">Last signed webhook received</dt><dd className="mt-1 font-sans text-[13px] text-text">{data.lastSignedWebhookAt ? new Date(data.lastSignedWebhookAt).toLocaleString() : 'None received'}</dd></div>
      <div><dt className="chrome text-[11px] text-text-muted">Rejected signature claims</dt><dd className="mt-1 font-sans text-[13px] text-text">{data.signatureFailures}</dd></div>
      <div className="min-w-0"><dt className="chrome text-[11px] text-text-muted">Configured listener address</dt><dd className="mt-1 break-all font-mono text-[12px] text-text">{data.listener ? `${data.listener.host}:${data.listener.port}/webhook` : 'Not configured'}</dd></div>
    </dl>}
    {data?.lastError && <p role="alert" className="mt-3 font-sans text-[13px] text-health-error">{data.lastError}</p>}
    {data?.signatureFailures ? <p className="mt-3 font-sans text-[13px] text-health-warn">Requests claiming this app failed signature verification. Counts are saved at most once a minute and when the listener stops; a crash can lose unsaved counts. This is not a connection health check.</p> : null}
    {formOpen && !connected && !configured && <form onSubmit={(event) => void install(event)} className="mt-5 space-y-4 border-t border-border-soft pt-5">
      <p className="font-sans text-[13px] leading-relaxed text-text-muted">Create a separate OAuth app for this agent in <a href="https://linear.app/settings/api/applications" target="_blank" rel="noreferrer" className="text-accent underline">Linear settings</a>. Select Agent session events, register the callback below, and expose the local webhook through your own HTTPS ingress.</p>
      <label className="block"><span className="mb-1 block font-sans text-[12px] text-text-muted">Client ID</span><input required value={clientId} onChange={(e) => setClientId(e.target.value)} className={inputClass} autoComplete="off" /></label>
      <label className="block"><span className="mb-1 block font-sans text-[12px] text-text-muted">Webhook signing secret</span><input type="password" required value={secret} onChange={(e) => setSecret(e.target.value)} className={inputClass} autoComplete="new-password" /></label>
      <label className="block"><span className="mb-1 block font-sans text-[12px] text-text-muted">OAuth callback URL</span><input type="url" required value={callback} onChange={(e) => setCallback(e.target.value)} className={inputClass} /></label>
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
        <label><span className="mb-1 block font-sans text-[12px] text-text-muted">Bind address</span><input required value={data?.listener?.host ?? host} disabled={Boolean(data?.listener)} onChange={(e) => setHost(e.target.value)} className={inputClass} /></label>
        <label><span className="mb-1 block font-sans text-[12px] text-text-muted">Port</span><input type="number" required min="1024" max="65535" value={data?.listener?.port ?? port} disabled={Boolean(data?.listener)} onChange={(e) => setPort(e.target.value)} className={inputClass} /></label>
      </div>
      <p className="font-sans text-[12px] leading-relaxed text-text-muted">Loopback is the default. All agents share this listener. It serves only signed webhooks at /webhook; the dashboard handles OAuth separately. Secrets stay in runtime storage and are never shown back.</p>
      <Button type="submit" disabled={busy}>{busy ? 'Preparing…' : 'Prepare authorization'}</Button>
    </form>}
    {authorizationUrl && <a href={authorizationUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-sm border border-accent px-4 font-sans text-[13px] text-accent">Authorize in Linear <ExternalLink className="size-3.5" /></a>}
    {error && <p role="alert" className="mt-3 font-sans text-[13px] text-health-error">{error}</p>}
    {(connected || formOpen || configured) && <p className="mt-4 font-sans text-[12px] leading-relaxed text-text-muted">Received requests persist locally. Requests never received during downtime are not recovered after Linear's retry window or disabled delivery. Restore delivery, check progress, then send a new prompt. Removing this connection does not uninstall the app from Linear.</p>}
  </Section>;
}
