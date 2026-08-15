import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import {
  DEFAULT_REASONING_EFFORT,
  type ProviderAvailability,
  type ProviderCatalogEntry,
} from '@shared/provider-catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import ConfirmModal from '@/components/ConfirmModal';
import DirectoryPicker from '@/components/DirectoryPicker';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { EditAffordance, ErrorHint, Field, SavedHint } from './Primitives';
import { ANIMA_MANAGED_PROVIDER_ENV_KEYS } from '@shared/agent-config';
import type { TeamConfig } from '@shared/server-settings';
import { effortOptionsForSelectedModel } from '@/lib/provider-availability';
export const RESERVED_ENV_KEYS = new Set<string>(ANIMA_MANAGED_PROVIDER_ENV_KEYS);

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
              <span className="block break-words font-serif text-[13px] md:text-[15px] text-text">{value}</span>
            ) : (
              <span className="font-serif italic text-[14px] text-text-subtle">{placeholder ?? '—'}</span>
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
  // Focus lifecycle. `HomeRow` renders this as `{showPicker && …}` and there is
  // no early return, so "mounted" already IS the open state.
  //
  // No `initialFocusRef`: the picker asks nothing, so its first control is not a
  // safe ANSWER the way a confirm's Cancel is — it is undo. Focus lands on the
  // container, which the hook keeps as a real resting place and Tab leaves at
  // once. Same reading as the team dialog's `HomeFolderPickerDialog`, which is
  // the same widget one screen over.
  //
  // No `descriptionId`: the body is a file tree, not prose.
  //
  // `titleId` replaces `aria-label="Choose workspace"`, which is the reason this
  // one is worth its own note. The visible title reads "Choose home folder", so
  // a screen reader announced a DIFFERENT name than the one on screen, and the
  // announced one used a word the product does not use anywhere else. Pointing
  // the name at the heading makes the two impossible to drift apart again.
  const { dialogRef, titleId } = useDialogFocus(true);

  // Escape is NOT gated on `isTopmostDialog()`, deliberately. Nothing can layer
  // over this dialog: `DirectoryPicker` declares no dialog of its own, so this
  // is always the top of the stack while it is open. The Server panel needed
  // the gate because it hosts `BusyConfirmModal`; adding one here would be a
  // rule with no case behind it. If a nested dialog ever appears under this
  // subtree, the predicate is the one-line answer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mx-4 max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-sm border border-border-soft bg-surface p-5 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <div id={titleId} className="mb-4 font-serif text-[16px] font-semibold text-text">
          Choose home folder
        </div>
        <DirectoryPicker startPath={startPath} onChoose={onChoose} onCancel={onClose} confirmLabel="Choose" />
      </div>
    </div>
  );
}

// ── HomeRow ─────────────────────────────────────────────────────────────

// Home row — hover-reveal Change affordance.
// Clicking opens a modal folder-picker; the agent applies the saved home when idle.
export function HomeRow({ value, onCommit }: { value: string; onCommit: (next: string) => Promise<void> }) {
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
              <span className="block break-words font-mono text-[13px] text-text">{pendingPath}</span>
              <span className="font-sans text-[11px] tracking-wide text-text-muted">
                Applies automatically when this agent is idle.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs" disabled={busy} onClick={() => void confirm()} className="min-h-[44px]">
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
                <span className="block break-words font-serif text-[13px] md:text-[15px] text-text">{value}</span>
              ) : (
                <span className="font-serif italic text-[14px] text-text-subtle">Not configured</span>
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

// ── TeamRow ───────────────────────────────────────────────────────────────

// Team row — reassign an existing agent to another team (add-existing-agent-to-
// team). Label-only: the agent's home is never moved. Hidden until a second team
// exists (progressive disclosure), so a single-team install shows no team chrome.
export function TeamRow({
  teams,
  value,
  onCommit,
}: {
  teams: TeamConfig[];
  value: string;
  onCommit: (teamId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  // Distinguishes "picked a team" (commit runs, keep the row until it resolves)
  // from "dismissed the menu" (close edit mode). Both fire onOpenChange(false),
  // and the `busy` state hasn't flushed yet when it does, so we track it in a ref.
  const committingRef = useRef(false);

  if (teams.length <= 1) return null;

  async function change(next: string) {
    if (!next || next === value) {
      setEditing(false);
      return;
    }
    if (busy) return;
    committingRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onCommit(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 4000);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Stay in edit mode so the error is visible next to the control.
    } finally {
      setBusy(false);
      committingRef.current = false;
    }
  }

  const currentName = teams.find((t) => t.id === value)?.name ?? value;

  return (
    <Field label="Team">
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={value}
            defaultOpen
            onValueChange={(v) => v && void change(v)}
            onOpenChange={(open) => {
              if (!open && !committingRef.current) setEditing(false);
            }}
          >
            <SelectTrigger className="h-8 w-52 font-serif text-[14px]" disabled={busy}>
              {currentName}
            </SelectTrigger>
            <SelectContent>
              {teams.map((t) => (
                <SelectItem key={t.id} value={t.id} className="font-serif text-[14px]">
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && <ErrorHint message={error} />}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <EditAffordance onEdit={() => setEditing(true)}>
            <span className="font-serif text-[13px] md:text-[15px] text-text">{currentName}</span>
          </EditAffordance>
          {saved && <SavedHint />}
        </div>
      )}
    </Field>
  );
}

// ── ProviderInlineRow ─────────────────────────────────────────────────────────

// Provider row — single line `kind · model · effort` in the top block.
// Kind changes reset model/effort because provider sessions cannot cross engines.
export function defaultEffortForModel(
  provider: ProviderCatalogEntry,
  model: string | undefined,
  availability: ProviderAvailability[] | null | undefined,
): string {
  const options = effortOptionsForSelectedModel(provider, model, availability);
  if (options.length === 0) return '';
  return options.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : (options[0] ?? '');
}

// ── ProviderEnvRow ──────────────────────────────────────────────────────────

export interface EnvDraftRow {
  deleted?: boolean;
  id: string;
  key: string;
  originalKey?: string;
  value: string;
}

// ── ConfirmRestartModal ───────────────────────────────────────────────────────

// Confirms changes that require this agent provider to reload before they apply.
export function ConfirmRestartModal({
  isActive,
  sessionBoundaryChanged = false,
  saving,
  onConfirm,
  onCancel,
}: {
  isActive: boolean;
  sessionBoundaryChanged?: boolean;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sessionCopy = sessionBoundaryChanged
    ? ' Switching provider or Claude Code session mode starts a fresh provider session; MEMORY.md, notes, and activity history stay intact.'
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

export function draftRowsFor(env?: Record<string, string>): EnvDraftRow[] {
  return Object.keys(env ?? {})
    .sort()
    .map((key) => ({
      id: `existing-${key}`,
      key,
      originalKey: key,
      value: '',
    }));
}

export function envPatchFromDraft(rows: EnvDraftRow[]): { patch: Record<string, string | null> } | { error: string } {
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
