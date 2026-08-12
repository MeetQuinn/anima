import { LogIn } from 'lucide-react';

import type { ClaudeCodeAccountState, ProviderAccountSummary } from '@shared/provider-accounts';
import type { ProviderUsageRow } from '@shared/provider-usage';
import ProviderAccountActionsMenu from '../ProviderAccountActionsMenu';
import { WindowRow } from './WindowRow';
import { extraValue, providerUsageErrorMessage, splitExtras } from './format';

/** Featured active (or sole) account — first card in the account stack. */
export function ActiveAccountCard({
  accountState,
  now,
  onLoginAccount,
  onRemoveAccount,
  usage,
}: {
  accountState?: ClaudeCodeAccountState;
  now: Date;
  onLoginAccount: (account: ProviderAccountSummary) => void;
  onRemoveAccount: (account: ProviderAccountSummary) => void;
  usage: ProviderUsageRow;
}) {
  const isAvailable = usage.status === 'available';
  const errorMessage = providerUsageErrorMessage(usage);
  const { plan, rest } = splitExtras(usage.extras);
  const summary = accountState?.accounts.find((account) => account.id === usage.accountId);
  const name = usage.account ?? summary?.account ?? summary?.label ?? usage.accountId;
  const canSignIn = Boolean(
    summary
    && (summary.status === 'not_configured' || usage.error?.type === 'unauthorized'),
  );

  return (
    <div className="rounded-md border border-border-soft bg-surface-raised px-3.5 py-3 shadow-lift">
      {(name || plan || usage.stale) && (
        <div className="flex min-w-0 items-baseline gap-2">
          {name && (
            <span className="min-w-0 truncate font-mono text-[12px] text-text" title={name}>
              {name}
            </span>
          )}
          {plan && (
            <span className="shrink-0 font-sans text-[11px] text-text-subtle">{plan}</span>
          )}
          {usage.stale && (
            <span className="shrink-0 font-sans text-[10px] text-text-subtle">· cached</span>
          )}
          <span className="min-w-0 flex-1" />
          <span className="flex shrink-0 items-center gap-1.5 font-sans text-[10px] font-medium text-text-muted">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-health-ok" />
            Active
          </span>
          {summary && (
            <ProviderAccountActionsMenu
              account={summary}
              name={name ?? summary.account ?? summary.label}
              onRemove={onRemoveAccount}
            />
          )}
        </div>
      )}
      {isAvailable ? (
        <div className={name || plan ? 'mt-3 space-y-2' : 'space-y-2'}>
          {usage.windows.map((w, i) => (
            <WindowRow key={i} w={w} now={now} />
          ))}
          {rest.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-0.5">
              {rest.map((e, i) => (
                <div key={i} className="flex items-baseline gap-1.5">
                  <span className="font-sans text-[11px] text-text-subtle">{e.label}</span>
                  <span className="font-mono text-[12px] tabular-nums text-text-muted">{extraValue(e)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-1">
          <span className="font-sans text-[12px] text-text-muted">
            {usage.error?.type === 'not_configured'
              ? 'Not configured'
              : usage.error?.type === 'unauthorized'
                ? 'Auth expired'
                : usage.error?.type === 'network_error'
                  ? 'Unreachable'
                  : 'Unavailable'}
          </span>
          {errorMessage && <p className="font-sans text-[11px] leading-relaxed text-text-subtle">{errorMessage}</p>}
          {canSignIn && summary && (
            <button
              type="button"
              onClick={() => onLoginAccount(summary)}
              className="mt-1 inline-flex min-h-[40px] items-center gap-1.5 font-sans text-[11px] font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <LogIn className="h-3.5 w-3.5" />
              Sign in again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
