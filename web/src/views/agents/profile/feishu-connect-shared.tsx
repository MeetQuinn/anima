import { ExternalLink, Loader2 } from 'lucide-react';
import { QRCode } from 'react-qr-code';

import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import type { AgentFeishuRegisterAppStatus } from '@shared/agent-config';

export const FEISHU_CONNECT_SLOW_SOFTEN_MS = 15_000;

const FEISHU_REGISTRATION_ACTIVE_STATES: AgentFeishuRegisterAppStatus['state'][] = [
  'starting',
  'waiting',
  'slow_down',
  'domain_switched',
];

export function isFeishuRegistrationActive(
  registration: AgentFeishuRegisterAppStatus | null | undefined,
): boolean {
  return Boolean(registration && FEISHU_REGISTRATION_ACTIVE_STATES.includes(registration.state));
}

export function FeishuCreatingAppLabel() {
  return (
    <span className="inline-flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
      Creating your Feishu app…
    </span>
  );
}

export function FeishuConnectingAppLabel() {
  return (
    <span className="inline-flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
      Connecting…
    </span>
  );
}

export function FeishuSlowLine() {
  return (
    <p className="text-center font-sans text-[12px] text-text-subtle">
      This is taking longer than usual.
    </p>
  );
}

export function FeishuConnectAffordances({
  frame = 'plain',
  verificationUrl,
}: {
  frame?: 'card' | 'plain';
  verificationUrl: string;
}) {
  const isMobile = useIsMobile();
  const frameClass = frame === 'card'
    ? 'rounded-sm border border-border-soft bg-surface px-4 py-6'
    : 'px-2 py-6';

  if (isMobile) {
    return (
      <div className={`flex flex-col items-center ${frameClass} text-center`}>
        <Button
          className="w-full max-w-xs"
          render={<a href={verificationUrl} rel="noreferrer" target="_blank" />}
        >
          Open Feishu
          <ExternalLink className="h-4 w-4" aria-hidden />
        </Button>
        <p className="mt-3 max-w-xs text-balance font-serif text-[13px] leading-relaxed text-text-muted">
          Open Feishu to confirm the new app there.
        </p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center ${frameClass} text-center`}>
      <span className="rounded-md border border-border-soft bg-white p-3">
        <QRCode value={verificationUrl} size={144} bgColor="#ffffff" fgColor="#1c1a17" level="M" />
      </span>
      <p className="mt-3 max-w-[18rem] text-balance font-serif text-[13px] leading-relaxed text-text-muted">
        Scan with Feishu, then confirm the new app there.
      </p>
      <a
        className="mt-3 inline-flex items-center gap-1.5 font-sans text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 transition-colors hover:text-text hover:decoration-text/40"
        href={verificationUrl}
        rel="noreferrer"
        target="_blank"
      >
        Or open the Feishu tab in your browser
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    </div>
  );
}

export function FeishuExistingCredentialsCard({
  appId,
  appSecret,
  description,
  disabled,
  onAppId,
  onAppSecret,
  onSubmit,
  saving,
}: {
  appId: string;
  appSecret: string;
  description: string;
  disabled: boolean;
  onAppId: (value: string) => void;
  onAppSecret: (value: string) => void;
  onSubmit: () => void;
  saving: boolean;
}) {
  return (
    <div className="space-y-3 rounded-sm border border-border-soft bg-surface px-4 py-3">
      <div>
        <div className="font-serif text-[14px] font-semibold text-text">
          Connect an existing Feishu app
        </div>
        <p className="mt-1 font-serif text-[12px] leading-snug text-text-muted">
          {description}
        </p>
      </div>
      <FeishuCredentialField
        label="App ID"
        placeholder="cli_..."
        value={appId}
        onChange={onAppId}
      />
      <FeishuCredentialField
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
        {saving ? <FeishuConnectingAppLabel /> : 'Connect Feishu app'}
      </Button>
    </div>
  );
}

function FeishuCredentialField({
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
