import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { DEFAULT_REASONING_EFFORT, type ProviderCatalogEntry } from '@shared/provider-catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import ConfirmModal from '@/components/ConfirmModal';
import DirectoryPicker from '@/components/DirectoryPicker';
import { EditAffordance, ErrorHint, Field, SavedHint } from './Primitives';
import { ANIMA_MANAGED_PROVIDER_ENV_KEYS, type AgentProviderConfig } from '@shared/agent-config';
import { providerKindLabel, providerValueLabel } from '@/lib/provider-display';

const RESERVED_ENV_KEYS = new Set<string>(ANIMA_MANAGED_PROVIDER_ENV_KEYS);

// ── InlineTextRow ─────────────────────────────────────────────────────────────

// Inline-editable text row (Name / Description). View binds to snapshot; only the
// actively-editing row holds a local draft, so a tick mid-edit cannot clobber.
export function InlineTextRow({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  function begin() {
    setDraft(value);
    setError(undefined);
    setSaved(false);
    setEditing(true);
  }

  async function commit() {
    if (busy) return;
    if (draft === value) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onCommit(draft);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Field label={label}>
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            autoFocus
            value={draft}
            placeholder={placeholder}
            disabled={busy}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
            }}
            className="h-8 w-64 max-w-full font-serif text-[15px]"
          />
          <Button size="xs" disabled={busy} onClick={() => void commit()}>
            <Check />
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
            <X />
            Cancel
          </Button>
          {error && <ErrorHint message={error} />}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <EditAffordance onEdit={begin}>
            {value ? (
              <span className="block break-all font-serif text-[13px] md:text-[15px] text-text">{value}</span>
            ) : (
              <span className="font-serif italic text-[14px] text-text-subtle">
                {placeholder ?? '—'}
              </span>
            )}
          </EditAffordance>
          {saved && <SavedHint />}
        </div>
      )}
    </Field>
  );
}

// ── WorkspacePickerModal ──────────────────────────────────────────────────────

// Full-screen backdrop modal wrapping DirectoryPicker. Esc closes.
function WorkspacePickerModal({
  startPath,
  onChoose,
  onClose,
}: {
  startPath?: string;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose workspace"
        className="mx-4 w-full max-w-2xl rounded-sm border border-border bg-surface p-5 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 font-serif text-[16px] font-semibold text-text">
          Choose home folder
        </div>
        <DirectoryPicker
          startPath={startPath}
          onChoose={onChoose}
          onCancel={onClose}
          confirmLabel="Choose"
        />
      </div>
    </div>
  );
}

// ── HomeRow ─────────────────────────────────────────────────────────────

// Home row — hover-reveal Change affordance.
// Clicking opens a modal folder-picker; the agent applies the saved home when idle.
export function HomeRow({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (next: string) => Promise<void>;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  async function confirm() {
    if (!pendingPath || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCommit(pendingPath);
      setPendingPath(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openPicker() {
    setSaved(false);
    setError(undefined);
    setShowPicker(true);
  }

  return (
    <>
      <Field label="Home">
        {pendingPath !== null ? (
          <div className="space-y-3">
            <div>
              <span className="block break-all font-mono text-[13px] text-text">{pendingPath}</span>
              <span className="font-sans text-[11px] tracking-wide text-text-muted">
                Applies automatically when this agent is idle.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                disabled={busy}
                onClick={() => void confirm()}
                className="min-h-[44px]"
              >
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => setPendingPath(null)}
                className="min-h-[44px]"
              >
                Cancel
              </Button>
              {error && <ErrorHint message={error} />}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="button"
              tabIndex={0}
              onClick={openPicker}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openPicker();
                }
              }}
              className="group -mx-2 -my-1 flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1 outline-none transition-colors hover:bg-surface-elevated focus-visible:bg-surface-elevated"
            >
              {value ? (
                <span className="block break-all font-serif text-[13px] md:text-[15px] text-text">{value}</span>
              ) : (
                <span className="font-serif italic text-[14px] text-text-subtle">
                  Not configured
                </span>
              )}
              <span className="font-sans text-[12px] text-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-50">
                Change
              </span>
            </div>
            {saved && <SavedHint />}
            {error && <ErrorHint message={error} />}
          </div>
        )}
      </Field>

      {showPicker && (
        <WorkspacePickerModal
          startPath={value || undefined}
          onChoose={(path) => {
            setShowPicker(false);
            setPendingPath(path);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </>
  );
}

// ── ProviderInlineRow ─────────────────────────────────────────────────────────

// Provider row — single line `kind · model · effort` in the top block.
// Kind changes reset model/effort because provider sessions cannot cross engines.
export function ProviderInlineRow({
  kind,
  model,
  effort,
  providerOptions,
  onRequestSave,
}: {
  kind: string;
  model: string;
  effort: string;
  providerOptions: ProviderCatalogEntry[];
  onRequestSave: (kind: string, model: string, effort?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftKind, setDraftKind] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftEffort, setDraftEffort] = useState('');
  const draftProvider = providerOptions.find((option) => option.kind === draftKind);
  const draftModelOptions = draftProvider?.models ?? [];
  const draftEffortOptions = draftProvider?.reasoningEfforts ?? [];
  const hasDraftEffort = draftEffortOptions.length > 0;
  const currentProvider = providerOptions.find((option) => option.kind === kind);
  const hasCurrentEffort = (currentProvider?.reasoningEfforts ?? []).length > 0;
  const kindChanged = draftKind !== kind;

  function begin() {
    setDraftKind(kind);
    setDraftModel(model);
    setDraftEffort(hasCurrentEffort ? effort : '');
    setEditing(true);
  }

  function handleKindChange(next: string | null) {
    if (!next) return;
    const nextProvider = providerOptions.find((option) => option.kind === next);
    if (!nextProvider) return;
    setDraftKind(nextProvider.kind);
    setDraftModel(nextProvider.defaultModel);
    setDraftEffort(defaultEffortForProvider(nextProvider));
  }

  function handleSave() {
    const nextEffort = hasDraftEffort ? draftEffort : undefined;
    const currentEffort = hasCurrentEffort ? effort : undefined;
    if (draftKind === kind && draftModel === model && nextEffort === currentEffort) {
      setEditing(false);
      return;
    }
    setEditing(false);
    onRequestSave(draftKind, draftModel, nextEffort);
  }

  return (
    <Field label="Provider">
      {editing ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={draftKind}
              onValueChange={handleKindChange}
            >
              <SelectTrigger className="h-8 w-40 font-serif text-[14px]">
                {providerKindLabel(draftKind, providerOptions)}
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((opt) => (
                  <SelectItem key={opt.kind} value={opt.kind} className="font-serif text-[14px]">
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={draftModel}
              onValueChange={(v) => {
                if (v) setDraftModel(v);
              }}
            >
              <SelectTrigger className="h-8 w-52 font-serif text-[14px]">
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
                <SelectTrigger className="h-8 w-36 font-serif text-[14px]">
                  {providerValueLabel(draftEffort)}
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
          {kindChanged && (
            <div className="max-w-xl font-sans text-[11px] leading-snug text-text-muted">
              Switching provider starts a fresh provider session. MEMORY.md, notes, and activity history stay intact;
              the old provider session is archived.
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button size="xs" onClick={handleSave}>
              <Check />
              Save
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              <X />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-baseline">
          <EditAffordance onEdit={begin}>
            <span className="font-serif text-[13px] md:text-[15px] text-text-muted">{providerKindLabel(kind, providerOptions)}</span>
            <span className="font-sans mx-1.5 text-[12px] text-text-subtle">·</span>
            <span className="font-serif text-[13px] md:text-[15px] text-text">{providerValueLabel(model) || '—'}</span>
            {hasCurrentEffort && (
              <>
                <span className="font-sans mx-1.5 text-[12px] text-text-subtle">·</span>
                <span className="font-serif text-[13px] md:text-[15px] text-text-muted">{providerValueLabel(effort)}</span>
              </>
            )}
          </EditAffordance>
        </div>
      )}
    </Field>
  );
}

function defaultEffortForProvider(provider: ProviderCatalogEntry): string {
  if (provider.reasoningEfforts.length === 0) return '';
  return provider.reasoningEfforts.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : provider.reasoningEfforts[0] ?? '';
}

// ── ProviderEnvRow ──────────────────────────────────────────────────────────

interface EnvDraftRow {
  deleted?: boolean;
  id: string;
  key: string;
  originalKey?: string;
  value: string;
}

export function ProviderEnvRow({
  env,
  onCommit,
}: {
  env?: Record<string, string>;
  onCommit: (patch: Record<string, string | null>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EnvDraftRow[]>(() => draftRowsFor(env));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const keys = Object.keys(env ?? {}).sort();

  // Rows are initialised in the open handler (onClick) so no effect needed.

  function updateRow(id: string, patch: Partial<EnvDraftRow>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setError(undefined);
    setSaved(false);
  }

  function addRow() {
    setRows((current) => [
      ...current,
      { id: `new-${Date.now()}-${current.length}`, key: '', value: '' },
    ]);
    setError(undefined);
    setSaved(false);
  }

  async function save() {
    if (busy) return;
    const result = envPatchFromDraft(rows);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    if (Object.keys(result.patch).length === 0) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onCommit(result.patch);
      setOpen(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Field label="Launch env">
      {!open ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setRows(draftRowsFor(env));
              setError(undefined);
              setOpen(true);
            }}
            className="group -mx-2 -my-1 flex min-w-0 cursor-pointer items-baseline gap-2 rounded-sm px-2 py-1 outline-none transition-colors hover:bg-surface-elevated focus-visible:bg-surface-elevated"
          >
            <span className="font-serif text-[13px] md:text-[15px] text-text">
              {keys.length === 0 ? 'None' : `${keys.length} variable${keys.length === 1 ? '' : 's'}`}
            </span>
            {keys.length > 0 && (
              <span className="max-w-sm truncate font-mono text-[12px] text-text-muted">
                {keys.join(', ')}
              </span>
            )}
            <span className="font-sans text-[12px] text-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-50">
              Advanced
            </span>
          </button>
          {saved && <SavedHint />}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            {rows.length === 0 && (
              <div className="font-serif text-[14px] italic text-text-subtle">
                No launch environment variables.
              </div>
            )}
            {rows.map((row) => (
              <div
                key={row.id}
                className={[
                  'grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]',
                  row.deleted ? 'opacity-45' : '',
                ].join(' ')}
              >
                <Input
                  value={row.key}
                  disabled={busy || row.deleted}
                  placeholder="KEY"
                  onChange={(e) => updateRow(row.id, { key: e.currentTarget.value })}
                  className="h-8 font-mono text-[12px]"
                />
                <Input
                  value={row.value}
                  disabled={busy || row.deleted}
                  placeholder={row.originalKey ? 'Leave blank to keep current value' : 'value'}
                  onChange={(e) => updateRow(row.id, { value: e.currentTarget.value })}
                  className="h-8 font-mono text-[12px]"
                />
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (row.originalKey) updateRow(row.id, { deleted: !row.deleted });
                    else setRows((current) => current.filter((candidate) => candidate.id !== row.id));
                  }}
                >
                  {row.deleted ? 'Keep' : 'Remove'}
                </Button>
                {RESERVED_ENV_KEYS.has(row.key.trim()) && !row.deleted && (
                  <div className="font-sans text-[11px] text-health-warn sm:col-span-3">
                    {row.key.trim()} is managed by Anima and cannot be set here.
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="font-sans text-[11px] leading-snug text-text-muted">
            Values are write-only after save. Anima-managed keys are not saved here; PATH is
            allowed, with Anima's bin directory prepended at launch.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="xs" variant="outline" disabled={busy} onClick={addRow}>
              Add var
            </Button>
            <Button type="button" size="xs" disabled={busy} onClick={() => void save()}>
              <Check />
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              <X />
              Cancel
            </Button>
            {error && <ErrorHint message={error} />}
          </div>
        </div>
      )}
    </Field>
  );
}

// ── ConfirmRestartModal ───────────────────────────────────────────────────────

// Confirms changes that require this agent provider to reload before they apply.
export function ConfirmRestartModal({
  isActive,
  kindChanged = false,
  saving,
  onConfirm,
  onCancel,
}: {
  isActive: boolean;
  kindChanged?: boolean;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sessionCopy = kindChanged
    ? ' Switching provider starts a fresh provider session; MEMORY.md, notes, and activity history stay intact.'
    : '';
  return (
    <ConfirmModal
      open={true}
      title={isActive ? 'Save and apply when idle?' : 'Apply provider change?'}
      description={
        isActive
          ? `Anima is mid-item. Save this config now; this agent will reload itself after the item finishes.${sessionCopy}`
          : `Save this config now; this agent will reload itself automatically.${sessionCopy}`
      }
      variant="warn"
      busy={saving}
      confirmLabel="Save"
      busyLabel="Saving…"
      confirmVariant="default"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

function draftRowsFor(env?: Record<string, string>): EnvDraftRow[] {
  return Object.keys(env ?? {}).sort().map((key) => ({
    id: `existing-${key}`,
    key,
    originalKey: key,
    value: '',
  }));
}

function envPatchFromDraft(rows: EnvDraftRow[]): { patch: Record<string, string | null> } | { error: string } {
  const patch: Record<string, string | null> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    const originalKey = row.originalKey;
    if (row.deleted) {
      if (originalKey) patch[originalKey] = null;
      continue;
    }
    if (!key && !row.value.trim() && !originalKey) continue;
    if (!key) return { error: 'Every env var needs a key.' };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { error: `${key} is not a valid environment variable key.` };
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      return { error: `${key} is managed by Anima and cannot be set here.` };
    }
    if (seen.has(key)) return { error: `${key} is listed more than once.` };
    seen.add(key);

    const value = row.value;
    if (originalKey && originalKey !== key) {
      if (!value) return { error: `Enter a value to rename ${originalKey}.` };
      patch[originalKey] = null;
      patch[key] = value;
      continue;
    }
    if (!originalKey && !value) return { error: `Enter a value for ${key}.` };
    if (value) patch[key] = value;
  }
  return { patch };
}

// ── Provider helpers ──────────────────────────────────────────────────────────

export function modelOptionsFor(
  provider: AgentProviderConfig,
  providerOptions: ProviderCatalogEntry[],
): string[] {
  const catalogModels = providerOptions.find((option) => option.kind === provider.kind)?.models ?? [];
  return [...catalogModels, provider.model].filter((m): m is string => Boolean(m));
}

export function effortOptionsFor(
  provider: AgentProviderConfig,
  providerOptions: ProviderCatalogEntry[],
): string[] {
  const catalogEfforts = providerOptions.find((option) => option.kind === provider.kind)?.reasoningEfforts ?? [];
  if (catalogEfforts.length === 0) return [];
  const providerEffort = 'reasoningEffort' in provider ? provider.reasoningEffort : undefined;
  return [...catalogEfforts, providerEffort].filter((effort): effort is string =>
    Boolean(effort),
  );
}
