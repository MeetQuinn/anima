import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

import { connectAgentFeishu, refreshDashboardData } from '@/api/agents';
import { Button } from '@/components/ui/button';

interface Props {
  agentId: string;
  onConnect?: () => void;
}

export function FeishuConnectStepper({ agentId, onConnect }: Props) {
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [botOpenId, setBotOpenId] = useState('');
  const [verificationToken, setVerificationToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const disabled = saving || !appId.trim() || !appSecret.trim();

  async function handleConnect() {
    if (disabled) return;
    setSaving(true);
    setError(undefined);
    try {
      await connectAgentFeishu(agentId, {
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        botOpenId: botOpenId.trim() || undefined,
        verificationToken: verificationToken.trim() || undefined,
      });
      setSaved(true);
      refreshDashboardData();
      onConnect?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Feishu connection failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-sm border border-border-soft bg-surface-elevated px-4 py-3">
        <div className="font-serif text-[14px] font-semibold text-text">
          Create a Feishu self-built app
        </div>
        <p className="font-serif mt-1 text-[13px] leading-snug text-text-muted">
          Enable the bot, turn on long-lived connection, subscribe to the message receive event{' '}
          <span className="font-mono text-[11px]">im.message.receive_v1</span>, then paste the app
          credentials below. Keep the app permissions limited to the Feishu actions this agent needs.
        </p>
      </div>

      <div className="space-y-3">
        <CredentialField
          label="App ID"
          placeholder="cli_..."
          value={appId}
          onChange={setAppId}
        />
        <CredentialField
          label="App Secret"
          placeholder="App secret"
          secret
          value={appSecret}
          onChange={setAppSecret}
        />
        <CredentialField
          label="Bot Open ID"
          optional
          placeholder="ou_..."
          value={botOpenId}
          onChange={setBotOpenId}
        />
        <CredentialField
          label="Verification Token"
          optional
          placeholder="Event subscription token"
          secret
          value={verificationToken}
          onChange={setVerificationToken}
        />
      </div>

      {error && (
        <p className="font-sans text-[12px] text-health-error">{error}</p>
      )}

      {saved && (
        <div className="flex items-center gap-2 rounded-sm border border-health-ok/30 bg-health-ok-soft px-4 py-3">
          <Check className="h-4 w-4 text-health-ok" />
          <span className="font-serif text-[13px] text-text">Feishu app credentials saved.</span>
        </div>
      )}

      <Button className="w-full" onClick={() => void handleConnect()} disabled={disabled}>
        {saving ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Saving…
          </span>
        ) : (
          'Save Feishu connection →'
        )}
      </Button>
    </div>
  );
}

function CredentialField({
  label,
  onChange,
  optional = false,
  placeholder,
  secret = false,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  optional?: boolean;
  placeholder: string;
  secret?: boolean;
  value: string;
}) {
  return (
    <label className="block">
      <span className="font-sans mb-1.5 block text-[12px] font-medium uppercase tracking-[0.08em] text-text-muted">
        {label}
        {optional ? <span className="normal-case tracking-normal text-text-subtle"> · optional</span> : null}
      </span>
      <input
        autoComplete="off"
        className="w-full rounded-sm border border-border-soft bg-surface px-3 py-2 font-mono text-[12px] text-text placeholder:font-sans placeholder:text-text-subtle focus:border-accent focus:outline-none"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        type={secret ? 'password' : 'text'}
        value={value}
      />
    </label>
  );
}
