import { useCallback, useEffect, useState } from 'react';
import { Check, Plus, Undo2, X } from 'lucide-react';
import type { ProviderAvailability, ProviderCatalogEntry } from '@shared/provider-catalog';
import type { AgentConfig, AgentUpdateProviderRequest } from '@shared/agent-config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { EditAffordance, ErrorHint, Field, extractError } from './Primitives';
import {
  ConfirmRestartModal,
  RESERVED_ENV_KEYS,
  defaultEffortForModel,
  draftRowsFor,
  envPatchFromDraft,
  type EnvDraftRow,
} from './AgentFields';
import {
  effortOptionsForSelectedModel,
  providerModelAuthorityLabel,
  providerReady,
  providerUnavailableHint,
  providerUnavailableLabel,
} from '@/lib/provider-availability';
import { providerKindLabel, providerValueLabel } from '@/lib/provider-display';
import { runtimeArgsFromEditor } from '@/components/usage/ProviderUnit';

type AgentProvider = NonNullable<AgentConfig['provider']>;

// ── RuntimeRow ────────────────────────────────────────────────────────────────

// Task #183: one "Runtime" ledger group merging the old Provider and Launch env
// rows, plus the agent-level runtime command/args overrides (PR #663 aligned).
// Read-only: the provider line always shows; the command and environment lines
// show ONLY when something is set. Editing happens in one modal, saved as one
// atomic provider update.
export function RuntimeRow({
  provider,
  providerOptions,
  providerAvailability,
  isActive,
  onCommit,
}: {
  provider: AgentProvider;
  providerOptions: ProviderCatalogEntry[];
  providerAvailability?: ProviderAvailability[] | null;
  isActive: boolean;
  onCommit: (update: AgentUpdateProviderRequest, opts: { envOnly: boolean }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const effort = 'reasoningEffort' in provider ? (provider.reasoningEffort ?? '') : '';
  const currentEntry = providerOptions.find((option) => option.kind === provider.kind);
  const hasEffort =
    effortOptionsForSelectedModel(currentEntry, provider.model, providerAvailability).length > 0;
  const commandSet = Boolean(provider.runtimeCommand) || (provider.runtimeArgs?.length ?? 0) > 0;
  const envKeys = Object.keys(provider.env ?? {}).sort();
  const commandLine = [provider.runtimeCommand ?? currentEntry?.command ?? provider.kind]
    .concat(provider.runtimeArgs ?? [])
    .join(' ');

  return (
    <Field label="Runtime">
      <EditAffordance onEdit={() => setOpen(true)}>
        <span className="flex min-w-0 flex-col gap-y-0.5">
          <span className="flex flex-wrap items-baseline">
            <span className="font-serif text-[13px] md:text-[15px] text-text-muted">
              {providerKindLabel(provider.kind, providerOptions)}
            </span>
            <span className="font-sans mx-1.5 text-[12px] text-text-subtle">·</span>
            <span className="font-serif text-[13px] md:text-[15px] text-text">
              {providerValueLabel(provider.model) || '—'}
            </span>
            {hasEffort && effort && (
              <>
                <span className="font-sans mx-1.5 text-[12px] text-text-subtle">·</span>
                <span className="font-serif text-[13px] md:text-[15px] text-text-muted">
                  {providerValueLabel(effort)}
                </span>
              </>
            )}
          </span>
          {/* Unset lines stay hidden (totoday 08-15: 如果command和env没设置就不要出). */}
          {commandSet && (
            <span className="max-w-md truncate font-mono text-[12px] text-text-muted" title={commandLine}>
              {commandLine}
            </span>
          )}
          {envKeys.length > 0 && (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="shrink-0 font-sans text-[12px] text-text-muted">
                {envKeys.length} env var{envKeys.length === 1 ? '' : 's'}
              </span>
              <span className="max-w-sm truncate font-mono text-[12px] text-text-subtle">{envKeys.join(', ')}</span>
            </span>
          )}
        </span>
      </EditAffordance>
      {open && (
        <RuntimeModal
          provider={provider}
          providerOptions={providerOptions}
          providerAvailability={providerAvailability}
          isActive={isActive}
          onCommit={onCommit}
          onClose={() => setOpen(false)}
        />
      )}
    </Field>
  );
}

// ── RuntimeModal ──────────────────────────────────────────────────────────────

// One modal, three groups (Provider / Command / Environment), one atomic save.
// Launch-affecting changes (provider selection, command, args) go through the
// existing reload confirm; an env-only change saves directly, matching the old
// Launch env row. Full-screen sheet under md, centered card above.
function RuntimeModal({
  provider,
  providerOptions,
  providerAvailability,
  isActive,
  onCommit,
  onClose,
}: {
  provider: AgentProvider;
  providerOptions: ProviderCatalogEntry[];
  providerAvailability?: ProviderAvailability[] | null;
  isActive: boolean;
  onCommit: (update: AgentUpdateProviderRequest, opts: { envOnly: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const currentEffortOptions = effortOptionsForSelectedModel(
    providerOptions.find((option) => option.kind === provider.kind),
    provider.model,
    providerAvailability,
  );
  const currentEffort =
    'reasoningEffort' in provider && currentEffortOptions.length > 0
      ? (provider.reasoningEffort ?? '')
      : '';

  // Drafts (initialised on mount; the modal is conditionally rendered).
  const [draftKind, setDraftKind] = useState(provider.kind as string);
  const [draftModel, setDraftModel] = useState(provider.model);
  const [draftEffort, setDraftEffort] = useState(currentEffort);
  const [draftCommand, setDraftCommand] = useState(provider.runtimeCommand ?? '');
  const [draftArgs, setDraftArgs] = useState((provider.runtimeArgs ?? []).join('\n'));
  const [envRows, setEnvRows] = useState<EnvDraftRow[]>(() => draftRowsFor(provider.env));
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<{
    update: AgentUpdateProviderRequest;
    sessionBoundaryChanged: boolean;
  } | null>(null);

  // Focus lifecycle: mounted IS open (rendered as `{open && …}`). No
  // `initialFocusRef` — the first control is an edit, not a safe answer, so
  // focus rests on the container. `titleId` names the dialog by its heading.
  const { dialogRef, titleId, isTopmostDialog } = useDialogFocus(true);

  // Every dismissal (Escape, header X, backdrop) is gated on `!busy`: while a
  // save is pending the editor must stay mounted so a rejection can render
  // inline with the drafts intact. Cancel/Save are disabled through the same
  // flag; unmounting mid-flight would drop the error on the floor.
  const requestClose = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  // Escape IS gated on `isTopmostDialog()`: the reload confirm stacks on top
  // of this dialog while `confirming` is set, and its own Escape must not
  // also dismiss the editor underneath (drafts would be lost).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && isTopmostDialog()) requestClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose, isTopmostDialog]);

  const draftEntry = providerOptions.find((option) => option.kind === draftKind);
  const draftModelOptions = draftEntry?.models ?? [];
  const draftEffortOptions = effortOptionsForSelectedModel(draftEntry, draftModel, providerAvailability);
  const hasDraftEffort = draftEffortOptions.length > 0;
  const kindChanged = draftKind !== provider.kind;
  const hadOverrides = Boolean(provider.runtimeCommand) || (provider.runtimeArgs?.length ?? 0) > 0;
  const draftUnavailableHint = providerAvailability
    ? providerUnavailableHint(draftEntry, providerAvailability)
    : undefined;
  const draftAuthority = providerModelAuthorityLabel(draftEntry, providerAvailability);
  const draftInstalled =
    !providerAvailability || !draftEntry || providerReady(draftEntry, providerAvailability);

  const nextEffort = hasDraftEffort ? draftEffort : undefined;
  const providerChanged =
    kindChanged || draftModel !== provider.model || (nextEffort ?? '') !== currentEffort;
  const saveBlocked = providerChanged && !draftInstalled;

  function providerSelectable(option: ProviderCatalogEntry): boolean {
    if (option.kind === provider.kind) return true;
    if (!providerAvailability) return true;
    return providerReady(option, providerAvailability);
  }

  function handleKindChange(next: string | null) {
    if (!next) return;
    const nextEntry = providerOptions.find((option) => option.kind === next);
    if (!nextEntry || !providerSelectable(nextEntry)) return;
    setDraftKind(nextEntry.kind);
    setDraftModel(nextEntry.defaultModel);
    setDraftEffort(defaultEffortForModel(nextEntry, nextEntry.defaultModel, providerAvailability));
    // A launch override written for the old provider's CLI does not transfer
    // (server drops it on kind change); the drafts mirror that.
    setDraftCommand('');
    setDraftArgs('');
    setError(undefined);
  }

  function handleModelChange(next: string | null) {
    if (!next || !draftEntry) return;
    setDraftModel(next);
    setDraftEffort(defaultEffortForModel(draftEntry, next, providerAvailability));
    setError(undefined);
  }

  function updateEnvRow(id: string, patch: Partial<EnvDraftRow>) {
    setEnvRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setError(undefined);
  }

  function addEnvRow() {
    setEnvRows((current) => [...current, { id: `new-${Date.now()}-${current.length}`, key: '', value: '' }]);
    setError(undefined);
  }

  function buildUpdate():
    | { update: AgentUpdateProviderRequest; launchAffecting: boolean }
    | { error: string } {
    const update: AgentUpdateProviderRequest = {};

    if (providerChanged) {
      update.kind = draftKind;
      update.model = draftModel;
      if (nextEffort) update.reasoningEffort = nextEffort;
    }

    const commandDraft = draftCommand.trim();
    const nextArgs = runtimeArgsFromEditor(draftArgs);
    let launchAffecting = providerChanged;
    if (kindChanged) {
      // The server drops old-kind overrides; only send values the operator
      // typed for the NEW kind.
      if (commandDraft) update.runtimeCommand = commandDraft;
      if (nextArgs.length > 0) update.runtimeArgs = nextArgs;
    } else {
      const currentCommand = provider.runtimeCommand ?? '';
      const currentArgs = provider.runtimeArgs ?? [];
      if (commandDraft !== currentCommand) {
        // Empty = inherit the Providers-page value (null clears the override).
        update.runtimeCommand = commandDraft || null;
        launchAffecting = true;
      }
      if (JSON.stringify(nextArgs) !== JSON.stringify(currentArgs)) {
        update.runtimeArgs = nextArgs.length > 0 ? nextArgs : null;
        launchAffecting = true;
      }
    }

    const envResult = envPatchFromDraft(envRows);
    if ('error' in envResult) return { error: envResult.error };
    if (Object.keys(envResult.patch).length > 0) update.env = envResult.patch;

    return { update, launchAffecting };
  }

  async function commit(update: AgentUpdateProviderRequest, envOnly: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await onCommit(update, { envOnly });
      onClose();
    } catch (e) {
      setError(extractError(e));
      setConfirming(null);
    } finally {
      setBusy(false);
    }
  }

  function handleSave() {
    if (busy || saveBlocked) return;
    const result = buildUpdate();
    if ('error' in result) {
      setError(result.error);
      return;
    }
    const { update, launchAffecting } = result;
    if (Object.keys(update).length === 0) {
      onClose();
      return;
    }
    if (launchAffecting) {
      setConfirming({ update, sessionBoundaryChanged: kindChanged });
    } else {
      void commit(update, true);
    }
  }

  // The modal speaks the same ledger language as the Setup section behind it:
  // a chrome label rail on the left, content on the right, groups divided by
  // soft rules. Full-screen sheet under md, centered card above.
  const railLabel = 'chrome pt-1 text-[11px] tracking-wide text-text-muted';
  const groupRow = 'grid gap-2.5 py-5 md:grid-cols-[6.5rem_1fr] md:gap-6';

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-page/70 backdrop-blur-sm md:items-center md:p-4"
      onClick={requestClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-full w-full flex-col overflow-y-auto border-border bg-surface shadow-deep md:h-auto md:max-h-[85vh] md:max-w-2xl md:rounded-sm md:border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-4 border-b border-border-soft px-6 py-4">
          <div id={titleId} className="min-w-0 font-serif text-[17px] font-semibold text-text">
            Runtime
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={busy}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-elevated hover:text-text disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 divide-y divide-border-soft px-6">
          {/* ── Provider ── */}
          <div className={groupRow}>
            <div className={railLabel}>Provider</div>
            <div className="space-y-2.5">
            {/* Mobile: three equal columns; md+: content-sized inline row. */}
            <div className="grid grid-cols-3 items-center gap-2 md:flex md:flex-wrap">
              <Select value={draftKind} onValueChange={handleKindChange}>
                <SelectTrigger className="!h-[44px] w-full font-serif text-[14px] md:!h-8 md:w-36" disabled={busy}>
                  {providerKindLabel(draftKind, providerOptions)}
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((opt) => {
                    const unavailableLabel = providerAvailability
                      ? providerUnavailableLabel(opt, providerAvailability)
                      : undefined;
                    return (
                      <SelectItem
                        key={opt.kind}
                        value={opt.kind}
                        disabled={!providerSelectable(opt)}
                        className="font-serif text-[14px]"
                      >
                        {opt.label}
                        {unavailableLabel ? ` · ${unavailableLabel}` : ''}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <Select value={draftModel} onValueChange={handleModelChange}>
                <SelectTrigger className="!h-[44px] w-full font-serif text-[14px] md:!h-8 md:w-48" disabled={busy}>
                  {providerValueLabel(draftModel)}
                </SelectTrigger>
                <SelectContent>
                  {draftModelOptions.map((opt) => (
                    <SelectItem key={opt} value={opt} className="font-serif text-[14px]">
                      {providerValueLabel(opt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {hasDraftEffort && (
                <Select
                  value={draftEffort}
                  onValueChange={(v) => {
                    if (v) setDraftEffort(v);
                  }}
                >
                  <SelectTrigger className="!h-[44px] w-full font-serif text-[14px] md:!h-8 md:w-28" disabled={busy}>
                    {draftEffort ? (
                      providerValueLabel(draftEffort)
                    ) : (
                      <span className="text-text-subtle">Effort</span>
                    )}
                  </SelectTrigger>
                  <SelectContent>
                    {draftEffortOptions.map((opt) => (
                      <SelectItem key={opt} value={opt} className="font-serif text-[14px]">
                        {providerValueLabel(opt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {draftUnavailableHint && (
              <div className="font-sans text-[11px] leading-snug text-text-muted">{draftUnavailableHint}</div>
            )}
            {draftAuthority && !draftUnavailableHint && (
              <div className="font-sans text-[10px] leading-snug text-text-subtle">{draftAuthority}</div>
            )}
            {kindChanged && (
              <div className="font-sans text-[11px] leading-snug text-text-muted">
                Starts a fresh provider session; memory, notes, and history stay intact.
                {hadOverrides ? ' The command override below was cleared; it was written for the old provider.' : ''}
              </div>
            )}
            </div>
          </div>

          {/* ── Command ── */}
          <div className={groupRow}>
            <div className={railLabel}>Command</div>
            <div className="space-y-2">
              {/* One quiet terminal card: prompt-prefixed command line, argv
                  lines below it. The args gutter (pl-7) aligns with the text
                  after the prompt glyph. */}
              <div className="overflow-hidden rounded-sm border border-border-soft bg-surface-elevated/50 transition-colors focus-within:border-border">
                <div className="flex items-center gap-2 px-3">
                  <span aria-hidden className="select-none font-mono text-[12px] text-text-subtle">
                    $
                  </span>
                  <input
                    value={draftCommand}
                    disabled={busy}
                    autoCapitalize="off"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={draftEntry?.command ?? draftKind}
                    onChange={(e) => {
                      setDraftCommand(e.currentTarget.value);
                      setError(undefined);
                    }}
                    className="h-9 w-full min-w-0 bg-transparent font-mono text-[12.5px] text-text placeholder:text-text-subtle focus:outline-none disabled:cursor-wait disabled:opacity-60"
                  />
                </div>
                <textarea
                  value={draftArgs}
                  disabled={busy}
                  autoCapitalize="off"
                  autoComplete="off"
                  spellCheck={false}
                  rows={3}
                  placeholder={draftKind === 'claude-code' ? '--chrome' : '--flag'}
                  onChange={(e) => {
                    setDraftArgs(e.currentTarget.value);
                    setError(undefined);
                  }}
                  className="block min-h-[64px] w-full resize-y border-t border-border-soft/70 bg-transparent py-2 pl-7 pr-3 font-mono text-[12.5px] leading-relaxed text-text placeholder:text-text-subtle focus:outline-none disabled:cursor-wait disabled:opacity-60"
                />
              </div>
              {/* Only the two non-obvious facts; the rest the editor shows. */}
              <p className="font-sans text-[11px] leading-snug text-text-muted">
                One argv entry per line. Empty falls back to the Providers-page settings.
              </p>
            </div>
          </div>

          {/* ── Environment ── */}
          <div className={groupRow}>
            <div className={railLabel}>Environment</div>
            <div className="space-y-2.5">
              {envRows.length > 0 && (
                <div className="space-y-1.5">
                  {envRows.map((row) => (
                    <div key={row.id} className={row.deleted ? 'opacity-45' : ''}>
                      {/* KEY = value reads as the assignment it becomes. */}
                      <div className="flex items-center gap-2">
                        <Input
                          value={row.key}
                          disabled={busy || row.deleted}
                          placeholder="KEY"
                          onChange={(e) => updateEnvRow(row.id, { key: e.currentTarget.value })}
                          className={`h-[44px] w-36 shrink-0 font-mono text-[12px] sm:w-44 md:h-8 ${row.deleted ? 'line-through' : ''}`}
                        />
                        <span aria-hidden className="select-none font-mono text-[12px] text-text-subtle">
                          =
                        </span>
                        <Input
                          value={row.value}
                          disabled={busy || row.deleted}
                          placeholder={row.originalKey ? 'unchanged' : 'value'}
                          onChange={(e) => updateEnvRow(row.id, { value: e.currentTarget.value })}
                          className="h-[44px] min-w-0 flex-1 font-mono text-[12px] md:h-8"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          title={row.deleted ? 'Keep this variable' : row.originalKey ? 'Remove on save' : 'Discard'}
                          onClick={() => {
                            if (row.originalKey) updateEnvRow(row.id, { deleted: !row.deleted });
                            else setEnvRows((current) => current.filter((candidate) => candidate.id !== row.id));
                          }}
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-subtle transition-colors hover:bg-surface-elevated hover:text-text disabled:opacity-40"
                        >
                          {row.deleted ? <Undo2 className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      {RESERVED_ENV_KEYS.has(row.key.trim()) && !row.deleted && (
                        <div className="mt-1 font-sans text-[11px] text-health-warn">
                          {row.key.trim()} is managed by Anima and cannot be set here.
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={addEnvRow}
                className="inline-flex items-center gap-1.5 font-sans text-[12px] text-text-muted transition-colors hover:text-text disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
                Add variable
              </button>
              {/* Reserved-key rejection surfaces inline per row. Saved values
                  never read back (placeholder says "unchanged") — totoday cut
                  the hint line explaining that; the placeholder carries it. */}
            </div>
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-soft px-6 py-3.5">
          {error && (
            <span className="mr-auto min-w-0 py-1">
              <ErrorHint message={error} />
            </span>
          )}
          <Button size="xs" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button size="xs" disabled={busy || saveBlocked} onClick={handleSave}>
            <Check />
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>

        {confirming && (
          <ConfirmRestartModal
            isActive={isActive}
            sessionBoundaryChanged={confirming.sessionBoundaryChanged}
            saving={busy}
            onConfirm={() => void commit(confirming.update, false)}
            onCancel={() => setConfirming(null)}
          />
        )}
      </div>
    </div>
  );
}
