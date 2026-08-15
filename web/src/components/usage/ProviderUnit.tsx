import { useState } from 'react';
import { ArrowUp, ChevronDown, Copy } from 'lucide-react';

import type { ProviderCliRow } from '@shared/provider-cli';
import type { ProviderContextLimitRow } from '@shared/provider-context-limits';
import type { ProviderRuntimeCommandRow } from '@shared/provider-runtime-commands';
import type { ProviderUsageRow } from '@shared/provider-usage';
import { BrandIcon } from './BrandIcon';
import { WindowRow } from './WindowRow';
import { extraValue, formatContextTokens, providerCollapsedSummary, providerUsageErrorMessage, splitExtras } from './format';

// ---------------------------------------------------------------------------
// Provider unit
// ---------------------------------------------------------------------------

// Refreshing is a panel-level act, not a per-row one: the header's "Refresh
// providers" re-reads every provider at once. The row is identity + usage for
// the single native credential; multi-account add/switch lives outside Anima.
export function ProviderUnit({
  expanded,
  globallyLocked = false,
  management,
  now,
  onApply,
  onCopyCommand,
  onToggleExpanded,
  usages,
  contextLimit,
  contextLimitError,
  contextLimitSaving = false,
  onContextLimitChange,
  runtimeCommand,
  runtimeCommandError,
  runtimeCommandSaving = false,
  onRuntimeCommandSave,
}: {
  expanded: boolean;
  globallyLocked?: boolean;
  management: ProviderCliRow;
  now: Date;
  onApply: () => void;
  onCopyCommand: () => void;
  onToggleExpanded: () => void;
  usages: ProviderUsageRow[];
  contextLimit?: ProviderContextLimitRow;
  contextLimitError?: string;
  contextLimitSaving?: boolean;
  onContextLimitChange: (maxTokens: number | null) => void;
  runtimeCommand: ProviderRuntimeCommandRow;
  runtimeCommandError?: string;
  runtimeCommandSaving?: boolean;
  onRuntimeCommandSave: (command: string | null, args: string[]) => void;
}) {
  const storedRuntimeCommand = runtimeCommand.command ?? '';
  const storedRuntimeArgs = runtimeCommand.args.join('\n');
  const [runtimeCommandEdit, setRuntimeCommandEdit] = useState({
    source: storedRuntimeCommand,
    value: storedRuntimeCommand,
  });
  const runtimeCommandDraft =
    runtimeCommandEdit.source === storedRuntimeCommand
      ? runtimeCommandEdit.value
      : storedRuntimeCommand;
  const [runtimeArgsEdit, setRuntimeArgsEdit] = useState({
    source: storedRuntimeArgs,
    value: storedRuntimeArgs,
  });
  const runtimeArgsDraft =
    runtimeArgsEdit.source === storedRuntimeArgs
      ? runtimeArgsEdit.value
      : storedRuntimeArgs;
  const usage = usages[0];
  const operation = management.operation.provider === management.provider ? management.operation : undefined;
  const runningAgents = management.agents.filter((agent) => agent.runningVersion);
  const canApply = management.updateAvailable && management.updateMode === 'managed';
  const updateLocked = globallyLocked || management.operation.status === 'running';
  const installing = operation?.status === 'running';
  const manualUpdate = !installing && management.updateAvailable && management.updateMode === 'manual';
  const updateOffer = !installing && management.updateAvailable && (canApply || manualUpdate);
  const staleSessions =
    operation?.status === 'succeeded' &&
    runningAgents.some((agent) => agent.runningVersion !== management.installedVersion);
  // Errors and in-flight operations force open so they are never trapped
  // behind a fold. A mere update offer does NOT auto-expand — it renders when
  // the user opens the provider, and the footer dot still signals it globally.
  const needsAttention = installing
    || operation?.status === 'failed'
    || staleSessions;
  const open = expanded || needsAttention;
  const collapsedSummary = providerCollapsedSummary(usage ? [usage] : []);
  const normalizedRuntimeCommand = runtimeCommandDraft.trim();
  const normalizedRuntimeArgs = runtimeArgsFromEditor(runtimeArgsDraft);
  const runtimeCommandChanged =
    normalizedRuntimeCommand !== storedRuntimeCommand ||
    JSON.stringify(normalizedRuntimeArgs) !== JSON.stringify(runtimeCommand.args);

  return (
    <div>
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={open}
        className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2.5 rounded-md px-1 py-1.5 text-left hover:bg-surface-elevated/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-text-subtle transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
          aria-hidden
        />
        <BrandIcon provider={management.provider} label={management.label} />
        <span className="min-w-0 flex-1 truncate font-serif text-[16px] font-semibold text-text">
          {management.label}
        </span>
        {!open && (
          <span className="max-w-[18rem] shrink-0 text-right font-sans text-[12px] leading-snug text-text-muted">
            {needsAttention ? (
              <span className="text-health-warn">Needs attention</span>
            ) : !management.installedVersion ? (
              management.state === 'not_installed' ? 'not installed' : 'version unknown'
            ) : (
              collapsedSummary
            )}
          </span>
        )}
        {open && !management.installedVersion && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-subtle">
            {management.state === 'not_installed' ? 'not installed' : 'version unknown'}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-3 pl-[42px]">
          {(needsAttention || updateOffer) && (
            <div className="space-y-1.5">
              {installing && <p className="font-sans text-[11px] text-text-muted">Installing…</p>}
              {operation?.status === 'failed' && (
                <p className="font-sans text-[11px] leading-relaxed text-health-error">
                  {operation.error ?? 'Update failed'}
                </p>
              )}
              {updateOffer && (
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="shrink-0 font-sans text-[11px] text-health-warn">
                    Update available{management.latestVersion ? ` ${management.latestVersion}` : ''}
                  </span>
                  {canApply ? (
                    <button
                      type="button"
                      onClick={onApply}
                      disabled={updateLocked}
                      title={management.latestVersion ? `Update to v${management.latestVersion}` : 'Update'}
                      className="flex h-[44px] shrink-0 items-center gap-1 rounded-sm bg-accent px-3 font-sans text-[10px] font-semibold text-white hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 md:h-6 md:px-2"
                    >
                      <ArrowUp className="h-3 w-3" />
                      Update
                    </button>
                  ) : (
                    management.manualCommand && (
                      <button
                        type="button"
                        onClick={onCopyCommand}
                        className="flex min-h-[44px] min-w-0 items-center gap-1.5 text-left font-mono text-[10px] text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent md:min-h-0"
                        title="Copy update command"
                      >
                        <Copy className="h-3 w-3 shrink-0" />
                        <span className="truncate">{management.manualCommand}</span>
                      </button>
                    )
                  )}
                </div>
              )}
              {staleSessions && (
                <p className="font-sans text-[11px] leading-relaxed text-text-muted">
                  New sessions use v{management.installedVersion}. Existing sessions keep their current version until
                  restart.
                </p>
              )}
            </div>
          )}

          {usage ? (
            <UsageCard now={now} usage={usage} />
          ) : (
            <div className="space-y-0.5 opacity-60">
              <span className="font-sans text-[12px] text-text-muted">Not configured</span>
            </div>
          )}

          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1 font-sans text-[10px] uppercase tracking-[0.08em] text-text-subtle hover:text-text-muted">
              <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
              Settings
            </summary>
            <div className="mt-2 space-y-4 border-l border-border-soft pl-3">
              <form
                className="space-y-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  onRuntimeCommandSave(
                    normalizedRuntimeCommand || null,
                    normalizedRuntimeArgs,
                  );
                }}
              >
                <label className="block font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-text-subtle">
                  Runtime command
                  <input
                    aria-label={`${management.label} runtime command`}
                    autoCapitalize="off"
                    autoComplete="off"
                    className="mt-1.5 block min-h-[44px] w-full rounded-sm border border-border-soft bg-surface-elevated px-3 font-mono text-[12px] text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
                    disabled={runtimeCommandSaving}
                    onChange={(event) =>
                      setRuntimeCommandEdit({
                        source: storedRuntimeCommand,
                        value: event.currentTarget.value,
                      })
                    }
                    placeholder={runtimeCommand.defaultCommand}
                    spellCheck={false}
                    value={runtimeCommandDraft}
                  />
                </label>
                <label className="block font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-text-subtle">
                  Arguments
                  <textarea
                    aria-label={`${management.label} runtime arguments`}
                    autoCapitalize="off"
                    autoComplete="off"
                    className="mt-1.5 block min-h-[88px] w-full resize-y rounded-sm border border-border-soft bg-surface-elevated px-3 py-2.5 font-mono text-[12px] leading-relaxed text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
                    disabled={runtimeCommandSaving}
                    onChange={(event) =>
                      setRuntimeArgsEdit({
                        source: storedRuntimeArgs,
                        value: event.currentTarget.value,
                      })
                    }
                    placeholder={management.provider === 'claude-code' ? '--chrome' : '--flag'}
                    rows={3}
                    spellCheck={false}
                    value={runtimeArgsDraft}
                  />
                </label>
                <div className="flex items-start justify-between gap-3">
                  <p className="font-sans text-[10px] leading-relaxed text-text-subtle">
                    Global for every agent using this provider. Command is an executable name or absolute path. Arguments are one argv entry per line; spaces are preserved and no shell parsing is used.
                  </p>
                  <button
                    type="submit"
                    className="min-h-[36px] shrink-0 rounded-sm border border-border-soft px-3 font-sans text-[11px] font-medium text-text-muted hover:border-border hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!runtimeCommandChanged || runtimeCommandSaving}
                  >
                    {runtimeCommandSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
                {runtimeCommandError && (
                  <p className="font-sans text-[10px] leading-relaxed text-health-error">
                    {runtimeCommandError}
                  </p>
                )}
              </form>

              {contextLimit && (
                <div className="space-y-1.5">
                  <label className="block font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-text-subtle">
                    Context limit
                    <select
                      aria-label={`${management.label} context limit`}
                      className="mt-1.5 block min-h-[44px] w-full rounded-sm border border-border-soft bg-surface-elevated px-3 font-sans text-[12px] text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
                      disabled={contextLimitSaving}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        onContextLimitChange(value === 'no-anima-limit' ? null : Number(value));
                      }}
                      value={contextLimit.maxTokens ?? 'no-anima-limit'}
                    >
                      <option value="no-anima-limit">No Anima limit</option>
                      {contextLimit.presets.map((preset) => (
                        <option key={preset} value={preset}>
                          {formatContextTokens(preset)}
                          {preset === contextLimit.recommended ? ' · recommended' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="font-sans text-[10px] leading-relaxed text-text-subtle">
                    Global for every agent. Applies when its provider session next starts.
                  </p>
                  {contextLimitError && (
                    <p className="font-sans text-[10px] leading-relaxed text-health-error">
                      {contextLimitError}
                    </p>
                  )}
                </div>
              )}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function UsageCard({ now, usage }: { now: Date; usage: ProviderUsageRow }) {
  const isAvailable = usage.status === 'available';
  const errorMessage = providerUsageErrorMessage(usage);
  const { plan, rest } = splitExtras(usage.extras);
  const name = usage.account;

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
        </div>
      )}
    </div>
  );
}

export function runtimeArgsFromEditor(value: string): string[] {
  return value
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}
