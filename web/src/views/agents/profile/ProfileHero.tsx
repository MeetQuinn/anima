import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { agentAvatarUrl, agentDisplayName } from '@/lib/agent-avatar';
import { EditAffordance, ErrorHint, SavedHint } from './Primitives';
import type { AgentConfig } from '@shared/agent-config';

// ── ProfileHero ───────────────────────────────────────────────────────────────
//
// The identity moment at the top of the Profile tab: large avatar + name +
// role + a quiet lifecycle line (passed in as children). The tab header above
// shows the same name at chrome scale; this block is deliberately a different
// composition - avatar ~3x the header's, display-size name, plus facts the
// header doesn't carry - so it reads as the page's subject, not a repeat.
// Health lives on the sidebar dot and the owner sits in the Setup ledger.
//
// Name and role stay inline-editable with the same begin/commit mechanics as
// InlineTextRow, restyled to hero scale. Only the actively-editing field holds
// a local draft, so a snapshot tick mid-edit cannot clobber it.

function HeroEditable({
  value,
  placeholder,
  ariaLabel,
  display,
  inputClassName,
  onCommit,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  display: (shown: string, empty: boolean) => React.ReactNode;
  inputClassName: string;
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

  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input
          autoFocus
          value={draft}
          placeholder={placeholder}
          disabled={busy}
          aria-label={ariaLabel}
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
          className={inputClassName}
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
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <EditAffordance onEdit={begin}>{display(value, !value)}</EditAffordance>
      {saved && <SavedHint />}
    </div>
  );
}

export function ProfileHero({
  agent,
  onCommitName,
  onCommitRole,
  children,
}: {
  agent: AgentConfig;
  onCommitName: (next: string) => Promise<void>;
  onCommitRole: (next: string) => Promise<void>;
  /** Quiet lifecycle meta line, rendered under the role at hero scale. */
  children?: React.ReactNode;
}) {
  const displayName = agentDisplayName(agent);
  const avatarUrl = agentAvatarUrl(agent);
  return (
    <div className="flex items-center gap-5 md:gap-6">
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className="h-20 w-20 shrink-0 rounded-xl object-cover shadow-deep ring-1 ring-border-soft md:h-24 md:w-24"
        />
      ) : (
        <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-muted font-serif text-[32px] font-semibold text-text-muted ring-1 ring-border-soft md:h-24 md:w-24">
          {displayName.charAt(0).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <HeroEditable
          value={agent.profile?.displayName ?? ''}
          placeholder="Unnamed"
          ariaLabel="Agent name"
          inputClassName="h-9 w-64 max-w-full font-serif text-[18px] font-semibold"
          onCommit={onCommitName}
          display={(shown, empty) =>
            empty ? (
              <span className="display text-[24px] font-semibold italic tracking-tight text-text-subtle md:text-[28px]">
                Unnamed
              </span>
            ) : (
              <span className="display block truncate text-[24px] font-semibold leading-tight tracking-tight text-text md:text-[28px]">
                {shown}
              </span>
            )
          }
        />
        <div className="mt-1">
          <HeroEditable
            value={agent.profile?.role ?? ''}
            placeholder="No role"
            ariaLabel="Agent role"
            inputClassName="h-8 w-full max-w-md font-serif text-[14px]"
            onCommit={onCommitRole}
            display={(shown, empty) =>
              empty ? (
                <span className="font-serif text-[14px] italic text-text-subtle">No role</span>
              ) : (
                <span className="block break-words font-serif text-[14px] leading-snug text-text-muted md:text-[15px]">
                  {shown}
                </span>
              )
            }
          />
        </div>
        {children && <div className="mt-2.5">{children}</div>}
      </div>
    </div>
  );
}
