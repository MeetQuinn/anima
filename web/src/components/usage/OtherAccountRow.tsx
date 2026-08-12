import type { ClaudeCodeAccountState, ProviderAccountSummary } from '@shared/provider-accounts';
import type { ProviderUsageRow } from '@shared/provider-usage';
import ProviderAccountActionsMenu from '../ProviderAccountActionsMenu';
import { WindowRow } from './WindowRow';
import { splitExtras } from './format';

/** Non-active multi-account row: one line, Use inline (not a second row). */
export function OtherAccountRow({
  accountState,
  now,
  onLoginAccount,
  onRemoveAccount,
  onSelectAccount,
  usage,
}: {
  accountState?: ClaudeCodeAccountState;
  now: Date;
  onLoginAccount: (account: ProviderAccountSummary) => void;
  onRemoveAccount: (account: ProviderAccountSummary) => void;
  onSelectAccount: (accountId: string) => void;
  usage: ProviderUsageRow;
}) {
  const summary = accountState?.accounts.find((account) => account.id === usage.accountId);
  const name = usage.account ?? summary?.account ?? summary?.label ?? usage.accountId ?? 'Account';
  const { plan } = splitExtras(usage.extras);
  const canSetActive = Boolean(
    accountState
    && usage.accountId
    && accountState.accounts.length > 1
    && accountState.activeAccountId !== usage.accountId
    && summary?.status === 'available'
    && accountState.status !== 'switching',
  );
  const canSignIn = Boolean(
    summary
    && (summary.status === 'not_configured' || usage.error?.type === 'unauthorized'),
  );
  const statusText = usage.status !== 'available'
    ? (usage.error?.type === 'unauthorized' ? 'Auth expired' : 'Unavailable')
    : null;

  return (
    <div className="rounded-md border border-border-soft/80 bg-surface px-3.5 py-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-text-muted" title={name}>
          {name}
        </span>
        {plan && <span className="shrink-0 font-sans text-[10px] text-text-subtle">{plan}</span>}
        {usage.stale && <span className="shrink-0 font-sans text-[10px] text-text-subtle">· cached</span>}
        {statusText && <span className="shrink-0 font-sans text-[10px] text-health-warn">{statusText}</span>}
        <span className="min-w-0 flex-1" />
        {canSignIn && summary ? (
          <button
            type="button"
            onClick={() => onLoginAccount(summary)}
            className="relative shrink-0 font-sans text-[11px] font-semibold text-text-muted after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Sign in
          </button>
        ) : canSetActive && usage.accountId ? (
          <button
            type="button"
            onClick={() => onSelectAccount(usage.accountId as string)}
            className="relative shrink-0 font-sans text-[11px] font-semibold text-text-muted after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            Use
          </button>
        ) : null}
        {summary && <ProviderAccountActionsMenu account={summary} name={name} onRemove={onRemoveAccount} />}
      </div>
      {usage.status === 'available' && usage.windows.length > 0 && (
        <div className="mt-2.5 space-y-1.5 opacity-80">
          {usage.windows.map((w, i) => (
            <WindowRow key={i} w={w} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
