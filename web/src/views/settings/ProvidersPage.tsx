import { Fragment, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import {
  applyProviderCliUpdate,
  cancelProviderLogin,
  checkProviderClis,
  fetchProviderContextLimits,
  fetchProviderRuntimeCommands,
  fetchProviderUsage,
  refreshProviderUsage,
  saveProviderContextLimit,
  saveProviderRuntimeCommand,
  startProviderLogin,
} from '@/api/system';
import { queryKeys } from '@/lib/query-keys';
import { useNow } from '@/hooks/useNow';
import { useConfirm } from '@/hooks/useConfirm';
import { useProviderCliStatus } from '@/hooks/useProviderCliStatus';
import { useProviderLogin } from '@/hooks/useProviderLogin';
import type { ProviderLoginMode } from '@shared/provider-login';
import type { ProviderCliRow } from '@shared/provider-cli';
import type { ProviderUsageKind, ProviderUsageRow } from '@shared/provider-usage';
import type { ProviderContextLimitRow } from '@shared/provider-context-limits';
import { providerCatalogEntry } from '@shared/provider-catalog';
import { ProviderUnit } from '@/components/usage/ProviderUnit';
import { UsageSkeleton } from '@/components/usage/UsageSkeleton';
import { loadExpandedProviders, persistExpandedProviders } from '@/components/usage/expanded-providers';
import { formatAgo } from '@/components/usage/format';

// ---------------------------------------------------------------------------
// ProvidersPage — the Providers settings page. Formerly the `UsagePanel`
// portal dialog; the settings shell now owns the chrome (title, back, URL) and
// this component is only the content. Provider logic is unchanged.
// ---------------------------------------------------------------------------

export default function ProvidersPage() {
  const queryClient = useQueryClient();
  const { confirm, modal } = useConfirm();
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
  const { data: loginData, isFetching: loginFetching, refetch: refetchLogin } = useProviderLogin();
  const [loginBusyProvider, setLoginBusyProvider] = useState<ProviderUsageKind>();
  const [loginFailure, setLoginFailure] = useState<{ message: string; provider: ProviderUsageKind }>();

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

  // Ticks every minute — keeps reset countdowns and "updated X ago" current.
  const now = useNow();

  const usageCheckedAt = usageData?.providers.reduce<string | undefined>((latest, row) => {
    if (!latest) return row.checkedAt;
    return row.checkedAt > latest ? row.checkedAt : latest;
  }, undefined);

  async function refreshAll(): Promise<void> {
    const [usage, , , status] = await Promise.all([
      refreshProviderUsage(),
      refetchContextLimits(),
      refetchRuntimeCommands(),
      checkProviderClis(),
      refetchLogin(),
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

  async function runProviderLogin(
    provider: ProviderUsageKind,
    action: 'cancel' | ProviderLoginMode,
  ): Promise<void> {
    setLoginBusyProvider(provider);
    setLoginFailure(undefined);
    try {
      const next =
        action === 'cancel'
          ? await cancelProviderLogin(provider)
          : await startProviderLogin(provider, action);
      queryClient.setQueryData(queryKeys.providerLogin(), next);
    } catch (error) {
      setLoginFailure({
        message: error instanceof Error ? error.message : 'Could not run the provider sign-in',
        provider,
      });
    } finally {
      setLoginBusyProvider(undefined);
    }
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
    contextLimitsFetching ||
    runtimeCommandsFetching ||
    loginFetching;

  return (
    <Fragment>
      {/* Toolbar — the dialog header's right-hand controls, now a row above the
          list: "checked N ago" + Refresh. Close is gone; the shell has Back. */}
      <div className="flex min-h-[44px] items-center justify-end gap-2 border-b border-border-soft">
        {checkedAt && (
          <span className="font-sans text-[10px] text-text-subtle">checked {formatAgo(checkedAt, now)}</span>
        )}
        <button
          onClick={() => void refreshAll()}
          disabled={fetching}
          className="flex h-[44px] w-[44px] items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40 md:h-7 md:w-7"
          aria-label="Refresh providers"
          title="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* ── Body ── */}
      <div className="py-5">
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
                        login={loginData?.providers.find(
                          (candidate) => candidate.provider === row.provider,
                        )}
                        loginBusy={loginBusyProvider === row.provider}
                        loginError={
                          loginFailure?.provider === row.provider ? loginFailure.message : undefined
                        }
                        onLoginStart={(mode) => {
                          void runProviderLogin(row.provider, mode);
                        }}
                        onLoginCancel={() => {
                          void runProviderLogin(row.provider, 'cancel');
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="font-serif italic text-[13px] text-text-subtle">No provider CLIs found.</p>
              )}
      </div>
      {modal}
    </Fragment>
  );
}
