import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderOpen, X } from 'lucide-react';
import { createTeam, updateTeam, type TeamConfig } from '@/api/teams';
import { queryClient } from '@/query-client';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import DirectoryPicker from '@/components/DirectoryPicker';

// ---------------------------------------------------------------------------
// Team modal — create ("+ New team") and edit (rename / change home) share one
// form. Name and home are both required. On create the server materializes the
// team folder; on edit the id is stable, so a rename never touches member
// agents, and changing the home only redirects where FUTURE agents land —
// existing agents keep their current folder (called out in the copy below).
// ---------------------------------------------------------------------------
function TeamModal({
  mode,
  team,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  team?: TeamConfig;
  onClose: () => void;
  onSaved: (team: TeamConfig) => void;
}) {
  const isEdit = mode === 'edit';
  const [name, setName] = useState(team?.name ?? '');
  const [home, setHome] = useState(team?.home ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      // Escape closes the directory picker first if it is open, then the modal.
      // (Inside the picker, the new-folder input has its own Cancel button.)
      if (showPicker) {
        setShowPicker(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy, showPicker]);

  async function submit() {
    const trimmedName = name.trim();
    const trimmedHome = home.trim();
    if (!trimmedName || !trimmedHome || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved =
        isEdit && team
          ? await updateTeam(team.id, { name: trimmedName, home: trimmedHome })
          : await createTeam({ name: trimmedName, home: trimmedHome });
      await queryClient.invalidateQueries({ queryKey: queryKeys.teams() });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : isEdit ? 'Could not save team' : 'Could not create team',
      );
      setBusy(false);
    }
  }

  const dirty = !isEdit || name.trim() !== team?.name || home.trim() !== team?.home;
  const canSubmit = !busy && !!name.trim() && !!home.trim() && dirty;

  return (
    <>
      {createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 p-4 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-sm border border-border-soft bg-surface p-6 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-serif text-[17px] font-semibold text-text">
          {isEdit ? 'Edit team' : 'New team'}
        </div>
        <div className="font-serif mt-1 text-[13px] leading-relaxed text-text-muted">
          {isEdit
            ? "Rename the team or change where new agents land. Renaming won't affect existing agents."
            : "A team groups your agents. New agents created in this team get their home under the team's folder. Existing agents stay visible."}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="mt-5 space-y-4"
        >
          <div>
            <label className="font-sans mb-1 block text-[12px] font-medium text-text-muted">
              Name
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
              placeholder="e.g. Content"
              className="w-full rounded-sm border border-border bg-muted/30 px-3 py-2 font-sans text-[14px] text-text placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <label className="font-sans mb-1 block text-[12px] font-medium text-text-muted">
              Home folder
            </label>
            <div className="flex items-stretch overflow-hidden rounded-sm border border-border bg-muted/30 transition-shadow focus-within:ring-1 focus-within:ring-ring">
              <Folder className="ml-3 mr-1 h-4 w-4 shrink-0 self-center text-text-subtle" />
              <input
                type="text"
                value={home}
                onChange={(e) => setHome(e.target.value)}
                disabled={busy}
                placeholder="e.g. ~/content"
                className="min-w-0 flex-1 bg-transparent py-2 pr-2 font-mono text-[13px] text-text placeholder:text-text-subtle focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                disabled={busy}
                className="font-sans flex shrink-0 items-center gap-1.5 self-stretch border-l border-border px-3 text-[12px] text-text-muted transition-colors hover:bg-surface-elevated hover:text-text disabled:opacity-50"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Browse
              </button>
            </div>
            <p className="font-sans mt-1 text-[11px] text-text-subtle">
              {isEdit ? (
                <>
                  Only affects agents created after this. Existing agents keep their current
                  folder and are not moved.
                </>
              ) : (
                <>
                  Required. Pick the team's home folder; new agents land under its{' '}
                  <code>agents/</code> subfolder.
                </>
              )}
            </p>
          </div>

          {error && (
            <div className="font-sans text-[12px] leading-snug text-health-error">{error}</div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose} variant="outline" disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isEdit ? (busy ? 'Saving…' : 'Save changes') : busy ? 'Creating…' : 'Create team'}
            </Button>
          </div>
        </form>
      </div>
    </div>,
        document.body,
      )}
      {showPicker &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-page/70 p-4 backdrop-blur-sm"
            onClick={() => setShowPicker(false)}
            role="presentation"
          >
            <div
              role="dialog"
              aria-modal="true"
              className="relative flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-sm border border-border-soft bg-surface shadow-deep"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center justify-between border-b border-border-soft px-5 py-4">
                <span className="font-serif text-[15px] font-semibold text-text">
                  Choose home folder
                </span>
                <button
                  type="button"
                  onClick={() => setShowPicker(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                <DirectoryPicker
                  startPath={home.trim() || undefined}
                  onChoose={(dir) => {
                    setHome(dir);
                    setShowPicker(false);
                  }}
                  onCancel={() => setShowPicker(false)}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// "+ New team" entry from the top-left switcher.
export function CreateTeamModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (team: TeamConfig) => void;
}) {
  return <TeamModal mode="create" onClose={onClose} onSaved={onCreated} />;
}

// Edit an existing team (rename / change home), opened from a team row in the switcher.
export function EditTeamModal({
  team,
  onClose,
  onSaved,
}: {
  team: TeamConfig;
  onClose: () => void;
  onSaved: (team: TeamConfig) => void;
}) {
  return <TeamModal mode="edit" team={team} onClose={onClose} onSaved={onSaved} />;
}
