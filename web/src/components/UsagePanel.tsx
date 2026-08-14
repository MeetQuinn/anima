import { Fragment, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { RefreshCw, X } from 'lucide-react';
import {
  applyProviderCliUpdate,
  checkProviderClis,
  fetchProviderAccounts,
  fetchProviderContextLimits,
  fetchProviderRuntimeCommands,
  fetchProviderUsage,
  removeClaudeAccount,
  refreshProviderUsage,
  saveProviderContextLimit,
  saveProviderRuntimeCommand,
  selectClaudeAccount,
} from '@/api/system';
import { queryKeys } from '@/lib/query-keys';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { useNow } from '@/hooks/useNow';
import { useConfirm } from '@/hooks/useConfirm';
import { useProviderCliStatus } from '@/hooks/useProviderCliStatus';
import type { ProviderCliRow } from '@shared/provider-cli';
import type { ProviderUsageKind, ProviderUsageRow } from '@shared/provider-usage';
import type { ClaudeCodeAccountState, ProviderAccountSummary } from '@shared/provider-accounts';
import type { ProviderContextLimitRow } from '@shared/provider-context-limits';
import { providerCatalogEntry } from '@shared/provider-catalog';
import ClaudeAccountLoginModal from './ClaudeAccountLoginModal';
import { ProviderUnit } from './usage/ProviderUnit';
import { UsageSkeleton } from './usage/UsageSkeleton';
import { loadExpandedProviders, persistExpandedProviders } from './usage/expanded-providers';
import { formatAgo } from './usage/format';

interface Props {
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// UsagePanel
// ---------------------------------------------------------------------------

export default function UsagePanel({ onClose }: Props) {
  const queryClient = useQueryClient();
  const { confirm, modal } = useConfirm();
  const [loginTarget, setLoginTarget] = useState<ProviderAccountSummary | 'new'>();
  const [expandedProviders, setExpandedProviders] = useState<Record<string, true>>(loadExpandedProviders);
  const [savingContextProvider, setSavingContextProvider] = useState<ProviderUsageKind>();
  const [contextLimitFailure, setContextLimitFailure] = useState<{
    message: string;
    provider: ProviderUsageKind;
  }>();
  const [savingRuntimeCommandProvider, setSavingRuntimeCommandProvider] =
    useState<ProviderUsageKind>();
  const [runtimeCommandFailure, setRuntimeCommandFailure] = useState<{
    message: string;
    provider: ProviderUsageKind;
  }>();
  const { data: cliData, isLoading: cliLoading, isFetching: cliFetching } = useProviderCliStatus();

  const {
    data: usageData,
    isLoading: usageLoading,
    isFetching: usageFetching,
  } = useQuery({
    queryKey: queryKeys.providerUsage(),
    queryFn: fetchProviderUsage,
    staleTime: 60_000,
  });
  const {
    data: runtimeCommands,
    isFetching: runtimeCommandsFetching,
    refetch: refetchRuntimeCommands,
  } = useQuery({
    queryKey: queryKeys.providerRuntimeCommands(),
    queryFn: fetchProviderRuntimeCommands,
    staleTime: 30_000,
  });
  const {
    data: contextLimits,
    isFetching: contextLimitsFetching,
    refetch: refetchContextLimits,
  } = useQuery({
    queryKey: queryKeys.providerContextLimits(),
    queryFn: fetchProviderContextLimits,
    staleTime: 30_000,
  });
  const {
    data: accountData,
    isFetching: accountsFetching,
    refetch: refetchAccounts,
  } = useQuery({
    queryKey: queryKeys.providerAccounts(),
    queryFn: fetchProviderAccounts,
    refetchInterval: (query) => query.state.data?.providers.some((provider) => provider.status === 'switching') ? 1_000 : false,
    staleTime: 30_000,
  });

  // Ticks every minute — keeps reset countdowns and "updated X ago" current.
  const now = useNow();

  // Focus lifecycle. Both call sites render this as `{open && <UsagePanel/>}`
  // and there is no early return past the dialog, so "mounted" already IS the
  // open state and the hook can be handed the constant.
  //
  // No `initialFocusRef`. Neither header control is a safe landing spot: Close
  // undoes the action that opened the panel, and Refresh re-checks every
  // provider CLI and re-reads provider usage — so a keyboard user who opens the
  // panel and presses Enter would fire a machine-wide provider sweep they never
  // asked for. A confirm lands on Cancel because a confirm ASKS something and
  // Cancel is the safe answer; a panel asks nothing. Focus lands on the
  // container, which the hook keeps as a real resting place and Tab leaves at
  // once. Same reading as the Server panel, which is the same chrome.
  //
  // No `descriptionId`: the body is provider rows, not prose.
  //
  // `titleId` replaces the hardcoded `aria-label="Providers"` so the announced
  // name and the visible header cannot drift apart.
  const { dialogRef, titleId, isTopmostDialog } = useDialogFocus(true);

  // Esc to close — but only while nothing is layered over the panel.
  //
  // This USED to read `!loginTarget`, a hand-rolled version of the same idea
  // that knew about exactly one of the two dialogs this panel can host. The
  // other is `useConfirm`'s ConfirmModal, reached from all three of the account
  // switch, account removal and CLI update paths — and with one of those open,
  // a single Escape cancelled the confirm AND closed the panel underneath it.
  // `isTopmostDialog()` asks the stack instead of enumerating, so it is right
  // for any dialog this panel grows later, including ones nested deeper than
  // this component can see.
  //
  // The rule stays here rather than in the hook: what to do about being covered
  // is dismissal policy and differs per dialog. The predicate is stable for the
  // life of the instance, so listing it does not reattach the listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTopmostDialog()) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isTopmostDialog]);

  const usageCheckedAt = usageData?.providers.reduce<string | undefined>((latest, row) => {
    if (!latest) return row.checkedAt;
    return row.checkedAt > latest ? row.checkedAt : latest;
  }, undefined);

  async function refreshAll(): Promise<void> {
    const [usage, , , , status] = await Promise.all([
      refreshProviderUsage(),
      refetchAccounts(),
      refetchContextLimits(),
      refetchRuntimeCommands(),
      checkProviderClis(),
    ]);
    queryClient.setQueryData(queryKeys.providerUsage(), usage);
    queryClient.setQueryData(queryKeys.providerCliStatus(), status);
  }

  function toggleProviderExpanded(provider: ProviderUsageKind): void {
    setExpandedProviders((prev) => {
      const next = { ...prev };
      if (next[provider]) delete next[provider];
      else next[provider] = true;
      persistExpandedProviders(next);
      return next;
    });
  }

  async function changeContextLimit(
    row: ProviderContextLimitRow,
    maxTokens: number | null,
  ): Promise<void> {
    setSavingContextProvider(row.provider);
    setContextLimitFailure(undefined);
    try {
      const next = await saveProviderContextLimit(row.provider, maxTokens);
      queryClient.setQueryData(queryKeys.providerContextLimits(), next);
    } catch (error) {
      setContextLimitFailure({
        message: error instanceof Error ? error.message : 'Could not save context limit',
        provider: row.provider,
      });
    } finally {
      setSavingContextProvider(undefined);
    }
  }

  async function changeRuntimeCommand(
    provider: ProviderUsageKind,
    command: string | null,
    args: string[],
  ): Promise<void> {
    setSavingRuntimeCommandProvider(provider);
    setRuntimeCommandFailure(undefined);
    try {
      const next = await saveProviderRuntimeCommand(provider, command, args);
      queryClient.setQueryData(queryKeys.providerRuntimeCommands(), next);
    } catch (error) {
      setRuntimeCommandFailure({
        message:
          error instanceof Error
            ? error.message
            : 'Could not save runtime command',
        provider,
      });
    } finally {
      setSavingRuntimeCommandProvider(undefined);
    }
  }

  function requestAccountSwitch(state: ClaudeCodeAccountState, accountId: string, retry = false): void {
    if (accountId === state.activeAccountId && !retry) return;
    const target = state.accounts.find((account) => account.id === accountId);
    if (!target) return;
    confirm({
      title: retry ? `Retry ${target.account ?? target.label}?` : `Switch to ${target.account ?? target.label}?`,
      description: (
        <p>
          {retry
            ? 'Only agents that did not reload this account will try again. Active turns on those agents are requeued to resume after reload.'
            : 'Active Claude turns are requeued to resume after the account reload; sessions, MCP servers, and shared state stay in place.'}
        </p>
      ),
      variant: 'warn',
      confirmVariant: 'default',
      confirmLabel: retry ? 'Retry' : 'Switch account',
      busyLabel: retry ? 'Retrying…' : 'Switching…',
      onConfirm: async () => {
        const next = await selectClaudeAccount(accountId);
        queryClient.setQueryData(queryKeys.providerAccounts(), { providers: [next] });
        queryClient.setQueryData(queryKeys.providerUsage(), await refreshProviderUsage());
      },
    });
  }

  function requestAccountRemoval(account: ProviderAccountSummary): void {
    const name = account.account ?? account.label;
    confirm({
      title: `Remove ${name}?`,
      description: (
        <div className="space-y-2">
          <p>This removes the local Claude sign-in and archives its isolated profile.</p>
          <p>Shared Claude projects and history stay in place. To use this account again, add it and sign in.</p>
        </div>
      ),
      variant: 'warn',
      confirmVariant: 'destructive',
      confirmLabel: 'Remove account',
      busyLabel: 'Removing…',
      onConfirm: async () => {
        const next = await removeClaudeAccount(account.id);
        queryClient.setQueryData(queryKeys.providerAccounts(), { providers: [next] });
        try {
          queryClient.setQueryData(queryKeys.providerUsage(), await refreshProviderUsage());
        } catch {
          // The account removal already committed. Avoid presenting a refresh
          // failure as a failed destructive action; retry usage in the background.
          void queryClient.invalidateQueries({ queryKey: queryKeys.providerUsage() });
        }
      },
    });
  }

  function requestApply(row: ProviderCliRow): void {
    const enabledAgents = row.agents.filter((agent) => agent.enabled);
    confirm({
      title: `Update ${row.label}?`,
      description: (
        <div className="space-y-2">
          <p>
            Update the machine-wide {row.label} binary from v{row.installedVersion} to v{row.latestVersion}. This
            affects {enabledAgents.length} {enabledAgents.length === 1 ? 'agent' : 'agents'}:{' '}
            {enabledAgents.map((agent) => agent.name).join(', ') || 'none'}.
          </p>
          <p>
            Running work is not interrupted. New versions take effect when each provider session next restarts. Login
            credentials and provider configuration are not changed.
          </p>
        </div>
      ),
      variant: 'warn',
      confirmVariant: 'default',
      confirmLabel: 'Update provider',
      busyLabel: 'Installing…',
      onConfirm: async () => {
        await applyProviderCliUpdate(row.provider);
        await queryClient.invalidateQueries({ queryKey: queryKeys.providerCliStatus() });
      },
    });
  }

  const usageByProvider = new Map<ProviderUsageKind, ProviderUsageRow[]>();
  for (const row of usageData?.providers ?? []) {
    const rows = usageByProvider.get(row.provider) ?? [];
    rows.push(row);
    usageByProvider.set(row.provider, rows);
  }
  const claudeAccountState = accountData?.providers.find((row) => row.provider === 'claude-code');
  // A provider whose binary genuinely isn't on this machine has nothing to show
  // or act on — hide it. State 'unknown' (binary present, version unverified)
  // still renders, with the honest 'version unknown' label (#520).
  const visible = (cliData?.providers ?? []).filter((row) => row.state !== 'not_installed');
  const checkedAt = [usageCheckedAt, ...visible.map((row) => row.checkedAt)]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const fetching =
    usageFetching ||
    cliFetching ||
    accountsFetching ||
    contextLimitsFetching ||
    runtimeCommandsFetching;

  return (
    <Fragment>
      {createPortal(
        <div className="fixed inset-0 z-50">
          {/* Desktop backdrop — click to close */}
          <div className="hidden md:block fixed inset-0 bg-page/70 backdrop-blur-sm" onClick={onClose} />

          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={[
              'relative flex h-full w-full flex-col bg-surface',
              'md:absolute md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2',
              'md:h-auto md:max-h-[calc(100dvh-4rem)] md:w-[min(640px,calc(100vw-2rem))] md:max-w-none md:rounded-sm md:border md:border-border-soft md:shadow-deep',
            ].join(' ')}
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            {/* ── Panel header ── */}
            {/* Mobile full-screen pages share the home header height (h-14 = 3.5rem,
            which is 52.5px at the app's 15px root, not 56px);
            the desktop modal keeps its compact h-10 chrome. */}
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border-soft px-3 md:h-10">
              <span id={titleId} className="caps text-text">
                Providers
              </span>
              <div className="flex items-center gap-2">
                {checkedAt && (
                  <span className="font-sans text-[10px] text-text-subtle">checked {formatAgo(checkedAt, now)}</span>
                )}
                <button
                  onClick={() => void refreshAll()}
                  disabled={fetching}
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40"
                  aria-label="Refresh providers"
                  title="Refresh"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={onClose}
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  aria-label="Close providers panel"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* ── Body ── */}
            <div className="flex-1 overflow-y-auto px-4 py-5 md:px-6">
              {usageLoading || cliLoading ? (
                <div className="space-y-6">
                  <UsageSkeleton />
                  <UsageSkeleton />
                </div>
              ) : visible.length > 0 ? (
                <div className="divide-y divide-border-soft">
                  {visible.map((row, i) => (
                    <div key={row.provider} className={i === 0 ? 'pb-4' : 'py-4 last:pb-1'}>
                      <ProviderUnit
                        contextLimit={contextLimits?.providers.find(
                          (limit) => limit.provider === row.provider,
                        )}
                        contextLimitError={
                          contextLimitFailure?.provider === row.provider
                            ? contextLimitFailure.message
                            : undefined
                        }
                        contextLimitSaving={savingContextProvider === row.provider}
                        expanded={Boolean(expandedProviders[row.provider])}
                        globallyLocked={cliData?.upgradeLocked}
                        management={row}
                        now={now}
                        onApply={() => requestApply(row)}
                        onCopyCommand={() => {
                          if (row.manualCommand) void navigator.clipboard.writeText(row.manualCommand);
                        }}
                        onToggleExpanded={() => toggleProviderExpanded(row.provider)}
                        usages={usageByProvider.get(row.provider) ?? []}
                        accountState={row.provider === 'claude-code' ? claudeAccountState : undefined}
                        onAddAccount={() => setLoginTarget('new')}
                        onLoginAccount={(account) => setLoginTarget(account)}
                        onRemoveAccount={requestAccountRemoval}
                        onContextLimitChange={(maxTokens) => {
                          const limit = contextLimits?.providers.find(
                            (candidate) => candidate.provider === row.provider,
                          );
                          if (limit) void changeContextLimit(limit, maxTokens);
                        }}
                        runtimeCommand={
                          runtimeCommands?.providers.find(
                            (candidate) => candidate.provider === row.provider,
                          ) ?? {
                            args: [],
                            command: null,
                            defaultCommand:
                              providerCatalogEntry(row.provider)?.command ?? row.provider,
                            provider: row.provider,
                          }
                        }
                        runtimeCommandError={
                          runtimeCommandFailure?.provider === row.provider
                            ? runtimeCommandFailure.message
                            : undefined
                        }
                        runtimeCommandSaving={
                          savingRuntimeCommandProvider === row.provider
                        }
                        onRuntimeCommandSave={(command, args) => {
                          void changeRuntimeCommand(row.provider, command, args);
                        }}
                        onRetryAccount={() => {
                          if (row.provider === 'claude-code' && claudeAccountState) {
                            requestAccountSwitch(claudeAccountState, claudeAccountState.activeAccountId, true);
                          }
                        }}
                        onSelectAccount={(accountId) => {
                          if (row.provider === 'claude-code' && claudeAccountState) {
                            requestAccountSwitch(claudeAccountState, accountId);
                          }
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="font-serif italic text-[13px] text-text-subtle">No provider CLIs found.</p>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {modal}
      {loginTarget && (
        <ClaudeAccountLoginModal
          account={loginTarget === 'new' ? undefined : loginTarget}
          onClose={() => setLoginTarget(undefined)}
          onSucceeded={() => {
            void Promise.all([
              queryClient.invalidateQueries({ queryKey: queryKeys.providerAccounts() }),
              refreshProviderUsage().then((usage) => {
                queryClient.setQueryData(queryKeys.providerUsage(), usage);
              }),
            ]);
          }}
        />
      )}
    </Fragment>
  );
}
