import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Folder, FolderOpen, X } from 'lucide-react';
import { createTeam, type TeamConfig } from '@/api/teams';
import { queryClient } from '@/query-client';
import { queryKeys } from '@/lib/query-keys';
import { Button } from '@/components/ui/button';
import DirectoryPicker from '@/components/DirectoryPicker';

// ---------------------------------------------------------------------------
// Create Team modal — the "+ New team" entry from the top-left switcher.
// Name is required; the home (team folder root) is an advanced, optional override
// (the server defaults it to a sibling `~/<id>` tree).
// ---------------------------------------------------------------------------
export function CreateTeamModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (team: TeamConfig) => void;
}) {
  const [name, setName] = useState('');
  const [home, setHome] = useState('');
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
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const team = await createTeam({
        name: trimmed,
        ...(home.trim() ? { home: home.trim() } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.teams() });
      onCreated(team);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create team');
      setBusy(false);
    }
  }

  return (
    <>
      {createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
      onClick={() => {
        if (!busy) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-sm border border-border-soft bg-surface p-6 shadow-deep"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-serif text-[17px] font-semibold text-text">New team</div>
        <div className="font-serif mt-1 text-[13px] leading-relaxed text-text-muted">
          A team groups your agents. New agents created in this team get their home under
          the team's folder. Existing agents stay visible.
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
                placeholder="~/content (defaults from the name)"
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
              The team's home folder. New agents land under its <code>agents/</code>
              {' '}subfolder. Leave blank to use the default.
            </p>
          </div>

          {error && (
            <div className="font-sans text-[12px] leading-snug text-health-error">{error}</div>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create team'}
            </Button>
            <Button type="button" onClick={onClose} variant="outline" disabled={busy}>
              Cancel
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
            className="fixed inset-0 z-[60] flex items-center justify-center bg-page/70 backdrop-blur-sm"
            onClick={() => setShowPicker(false)}
            role="presentation"
          >
            <div
              role="dialog"
              aria-modal="true"
              className="relative w-full max-w-2xl rounded-sm border border-border-soft bg-surface shadow-deep"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-border-soft px-5 py-4">
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
              <div className="p-5">
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
