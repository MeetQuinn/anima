import { useEffect, useId, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { fetchAgentSlackUsers, setAgentOwner, refreshDashboardData } from '@/api/agents';
import { Button } from '@/components/ui/button';
import type { SlackUserCandidate } from '@shared/agent-config';

// ---------------------------------------------------------------------------
// Rationale blurb — shown in onboarding step 3 and Profile entry point

function Rationale() {
  return (
    <p className="font-sans text-[13px] leading-relaxed text-text-muted">
      The owner is the person this agent answers to. The agent introduces itself to them and checks in — it's how it knows who it's working for.
    </p>
  );
}

// ---------------------------------------------------------------------------
// OwnerPickerForm
//
// Reusable owner selection UI used in:
//   - Onboarding step 3 (first-run assign owner)
//   - Profile panel (assign/change owner via modal)
//
// Props:
//   agentId       — agent to call POST /slack/owner on
//   onConfirm     — called after a successful setOwner
//   onSkip        — optional; if provided, a "Skip for now →" link is shown
//   submitLabel   — CTA label (default: "Assign owner →")
//   autoFocus     — focus the combobox input on mount (default: true)
//   showRationale — show the "why assign an owner" blurb (default: false)
// ---------------------------------------------------------------------------

interface OwnerPickerFormProps {
  agentId: string;
  onConfirm: () => void;
  onSkip?: () => void;
  submitLabel?: string;
  autoFocus?: boolean;
  showRationale?: boolean;
}

export function OwnerPickerForm({
  agentId,
  onConfirm,
  onSkip,
  submitLabel = 'Assign owner →',
  autoFocus = true,
  showRationale = false,
}: OwnerPickerFormProps) {
  const uid = useId();
  const listboxId = `${uid}-listbox`;
  const optionId = (userId: string) => `${uid}-option-${userId}`;

  const [candidates, setCandidates] = useState<SlackUserCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();

  // Combobox state
  const [inputValue, setInputValue] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [selectedId, setSelectedId] = useState('');

  // Form state
  const [introduce, setIntroduce] = useState(true);
  const [openerNote, setOpenerNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------------
  // Load candidates
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    fetchAgentSlackUsers(agentId)
      .then((users) => { if (!cancelled) { setCandidates(users); setLoading(false); } })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Could not load Slack members');
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [agentId]);

  // Close dropdown on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (autoFocus && !loading) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [autoFocus, loading]);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const selectedUser = candidates.find((u) => u.slackUserId === selectedId);

  const filtered = inputValue.trim()
    ? candidates.filter((u) => {
        const q = inputValue.trim().toLowerCase();
        return (
          u.displayName.toLowerCase().includes(q) ||
          (u.handle && u.handle.toLowerCase().includes(q))
        );
      })
    : candidates;

  const activeDescendant =
    isOpen && highlightIdx >= 0 && filtered[highlightIdx]
      ? optionId(filtered[highlightIdx].slackUserId)
      : undefined;

  // Scroll highlighted option into view when keyboard navigating past the
  // max-h-52 visible window.
  useEffect(() => {
    if (!isOpen || highlightIdx < 0) return;
    document.getElementById(optionId(filtered[highlightIdx]?.slackUserId ?? ''))
      ?.scrollIntoView({ block: 'nearest' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIdx, isOpen]);

  // ---------------------------------------------------------------------------
  // Combobox handlers
  // ---------------------------------------------------------------------------

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setInputValue(val);
    setIsOpen(true);
    setHighlightIdx(-1);
    // Clear selection if user changes the query away from the selected name
    if (selectedId && val !== (selectedUser?.displayName ?? '')) {
      setSelectedId('');
      setSaveError(undefined);
    }
  }

  function handleInputFocus() {
    setIsOpen(true);
    // If there's a selected user, clear the input so they can search
    if (selectedId) {
      setInputValue('');
    }
  }

  function handleInputBlur() {
    // Restore selected user's display name if they blurred without changing selection
    if (selectedUser && !isOpen) {
      setInputValue(selectedUser.displayName);
    } else if (!selectedUser) {
      // leave as-is — closing via outside click handles this
    }
  }

  function handleSelect(user: SlackUserCandidate) {
    setSelectedId(user.slackUserId);
    setInputValue(user.displayName);
    setIsOpen(false);
    setHighlightIdx(-1);
    setSaveError(undefined);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!isOpen) {
      if (e.key === 'ArrowDown') { setIsOpen(true); setHighlightIdx(0); e.preventDefault(); }
      return;
    }
    if (e.key === 'Escape') {
      setIsOpen(false);
      setHighlightIdx(-1);
      // Restore selected name on escape
      if (selectedUser) setInputValue(selectedUser.displayName);
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setHighlightIdx((i) => Math.max(i - 1, 0));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = highlightIdx >= 0 ? filtered[highlightIdx] : filtered[0];
      if (target) handleSelect(target);
    }
  }

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  async function handleConfirm() {
    if (!selectedId || saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await setAgentOwner(agentId, {
        slackUserId: selectedId,
        introduce,
        ...(introduce && openerNote.trim() ? { openerNote: openerNote.trim() } : {}),
      });
      refreshDashboardData();
      onConfirm();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not assign owner');
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-3">
        {showRationale && <Rationale />}
        <div className="font-sans text-[12px] text-text-muted">Loading Slack members…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-2">
        {showRationale && <Rationale />}
        <div className="font-sans text-[12px] text-health-error">{loadError}</div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setLoading(true);
            setLoadError(undefined);
            fetchAgentSlackUsers(agentId)
              .then((users) => { setCandidates(users); setLoading(false); })
              .catch((err) => { setLoadError(err instanceof Error ? err.message : 'Could not load Slack members'); setLoading(false); });
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-3">
      {showRationale && <Rationale />}

      {/* Combobox */}
      <div ref={containerRef} className="relative">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          placeholder={selectedUser ? selectedUser.displayName : 'Search by name or handle…'}
          disabled={saving}
          className="w-full rounded-sm border border-border-soft bg-surface px-3 py-2 font-sans text-[13px] text-text placeholder:text-text-subtle focus:border-accent focus:outline-none disabled:opacity-50"
        />
        {/* Show selected badge inside the input row when closed + selected */}
        {selectedUser && !isOpen && (
          <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
            <Check className="h-3.5 w-3.5 text-accent" />
          </div>
        )}

        {/* Floating dropdown */}
        {isOpen && (
          <div
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-52 overflow-y-auto rounded-sm border border-border-soft bg-surface shadow-deep"
          >
            {filtered.length === 0 ? (
              <div className="px-3 py-2 font-sans text-[12px] text-text-muted">
                {candidates.length === 0 ? 'No workspace members found.' : 'No members match.'}
              </div>
            ) : (
              filtered.map((user, idx) => {
                const selected = user.slackUserId === selectedId;
                const highlighted = idx === highlightIdx;
                return (
                  <button
                    key={user.slackUserId}
                    id={optionId(user.slackUserId)}
                    role="option"
                    aria-selected={selected}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); handleSelect(user); }}
                    className={[
                      'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                      highlighted ? 'bg-accent/10' : selected ? 'bg-accent/5' : 'hover:bg-surface-elevated',
                    ].join(' ')}
                  >
                    {user.avatarUrl ? (
                      <img src={user.avatarUrl} alt="" className="h-6 w-6 shrink-0 rounded-sm object-cover" />
                    ) : (
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-muted font-sans text-[10px] font-bold text-text-muted">
                        {user.displayName.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-serif text-[14px] text-text">
                        {user.displayName}
                      </span>
                      {user.handle && (
                        <span className="font-sans text-[11px] text-text-muted">@{user.handle}</span>
                      )}
                    </span>
                    {selected && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Intro toggle */}
      <div className="space-y-1">
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={introduce}
            onChange={(e) => setIntroduce(e.target.checked)}
            disabled={saving}
            className="h-4 w-4 accent-accent"
          />
          <span className="font-sans text-[13px] text-text">
            {selectedUser ? (
              <>Notify <span className="font-medium">{selectedUser.displayName}</span> now</>
            ) : (
              'Notify the new owner now'
            )}
          </span>
        </label>
        <p className="font-sans pl-[26px] text-[11px] text-text-subtle">
          The agent will DM them to introduce itself.
        </p>
      </div>

      {/* Opener textarea — gated on introduce ON */}
      {introduce && (
        <div>
          <label className="font-sans mb-1.5 block text-[12px] font-medium text-text-muted">
            What should the agent know before it reaches out to{' '}
            {selectedUser ? selectedUser.displayName : 'its owner'}?{' '}
            <span className="font-normal">(optional)</span>
          </label>
          <textarea
            value={openerNote}
            onChange={(e) => setOpenerNote(e.target.value)}
            placeholder={
              selectedUser
                ? `e.g. I set this agent up to help ${selectedUser.displayName} with code review and deploys.`
                : 'e.g. I set this agent up to help them with code review and deploys.'
            }
            rows={3}
            className="w-full resize-none rounded-sm border border-border-soft bg-surface px-3 py-2 font-sans text-[13px] text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
          />
          <p className="font-sans mt-1 text-[11px] text-text-subtle">
            Used as context for the agent's first message —{' '}
            {selectedUser
              ? `so ${selectedUser.displayName} knows who set it up and why.`
              : 'so the owner knows who set it up and why.'}
          </p>
        </div>
      )}

      {/* Error */}
      {saveError && (
        <div className="font-sans text-[12px] text-health-error">{saveError}</div>
      )}

      {/* Actions */}
      <div className="space-y-2">
        <Button
          className="w-full"
          onClick={() => void handleConfirm()}
          disabled={saving || !selectedId}
        >
          {saving ? 'Assigning…' : submitLabel}
        </Button>
        {onSkip && (
          <div className="text-center">
            <button
              type="button"
              onClick={onSkip}
              disabled={saving}
              className="font-sans text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 hover:text-text hover:decoration-text/40 transition-colors"
            >
              Skip for now →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
