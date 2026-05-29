import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { createAgent, refreshDashboardData } from '@/api/agents';
import { fetchProviderAvailability } from '@/api/system';
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_PROVIDER_KIND,
  providerCatalog,
  type ProviderCatalogEntry,
} from '@shared/provider-catalog';
import { DEFAULT_AGENT_HOMES_ROOT, defaultAgentHomePath } from '@shared/agent-home';
import {
  firstReadyProvider,
  providerReady,
  providerUnavailableHint,
  providerUnavailableLabel,
  unavailableProviderHints,
} from '@/lib/provider-availability';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import DirectoryPicker from '@/components/DirectoryPicker';
import { slugify } from './utils';
import { queryKeys } from '@/lib/query-keys';
import { providerValueLabel } from '@/lib/provider-display';


// ---------------------------------------------------------------------------
// Add agent modal
//
// Field order (locked): Name → Role → Home → Provider → Model.
//
// Home defaults to DEFAULT_AGENT_HOMES_ROOT/<id> (auto-created on submit). Operator
// sees a read-only preview with "will be created" and a "Change location"
// link. Clicking "Change location" swaps the modal body to DirectoryPicker as a
// parent-picker: chosen dir + /<id> becomes the home. "Reset to default"
// reverts to DEFAULT_AGENT_HOMES_ROOT. Backend receives the final homePath.
// ---------------------------------------------------------------------------
export function AddAgentModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [role, setRole] = useState('');
  // null = use DEFAULT_AGENT_HOMES_ROOT (backend auto-creates); non-null = custom parent chosen via picker
  const [customParent, setCustomParent] = useState<string | null>(null);
  const [showBrowser, setShowBrowser] = useState(false);
  const [providerKind, setProviderKind] = useState<ProviderCatalogEntry['kind']>(DEFAULT_PROVIDER_KIND);
  const [model, setModel] = useState(
    providerCatalog().find((o) => o.kind === DEFAULT_PROVIDER_KIND)?.defaultModel ?? '',
  );
  const [effort, setEffort] = useState(DEFAULT_REASONING_EFFORT);
  const {
    data: providerAvailability,
    error: providerAvailabilityError,
  } = useQuery({ queryKey: queryKeys.providerAvailability(), queryFn: fetchProviderAvailability });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const providerOptions = useMemo(() => providerCatalog(), []);

  const derivedId = slugify(name);
  const currentProvider = providerOptions.find((o) => o.kind === providerKind);
  const selectedProviderReady = providerReady(currentProvider, providerAvailability);
  const selectedProviderHint = providerUnavailableHint(currentProvider, providerAvailability);
  const unavailableProviders = unavailableProviderHints(providerOptions, providerAvailability);
  // Preview path shown to the user — always computed from name + chosen/default parent.
  const previewPath = derivedId
    ? defaultAgentHomePath(derivedId, customParent ?? DEFAULT_AGENT_HOMES_ROOT)
    : null;

  function handleProviderChange(next: ProviderCatalogEntry['kind']) {
    setProviderKind(next);
    setModel(providerOptions.find((o) => o.kind === next)?.defaultModel ?? '');
    setEffort(DEFAULT_REASONING_EFFORT);
  }

  useEffect(() => {
    if (!providerAvailability) return;
    const activeProvider = providerOptions.find((o) => o.kind === providerKind);
    if (providerReady(activeProvider, providerAvailability)) return;
    const next = firstReadyProvider(providerOptions, providerAvailability);
    if (!next) return;
    setTimeout(() => {
      setProviderKind(next.kind);
      setModel(next.defaultModel);
    }, 0);
  }, [providerAvailability, providerKind, providerOptions]);

  useEffect(() => {
    setTimeout(() => nameInputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return;
      // When the folder browser is open, Esc returns to the form (not closes the modal).
      if (showBrowser) {
        setShowBrowser(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy, showBrowser]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setNameTouched(true);
    if (!derivedId || !previewPath || !role.trim() || !providerKind || !model || !selectedProviderReady)
      return;
    setBusy(true);
    setError(null);
    const provider = {
      kind: providerKind,
      model,
      ...((currentProvider?.reasoningEfforts ?? []).length > 0 ? { reasoningEffort: effort } : {}),
    };
    try {
      const agent = await createAgent({
        name: name.trim(),
        homePath: previewPath,
        role: role.trim(),
        provider,
      });
      // N1 fix: refresh agents before pushing so AgentReconciler sees the new
      // agent in the roster and doesn't reset the URL to null/re-pick.
      refreshDashboardData();
      // Navigate to the new agent — reconcileLocation will redirect to 'profile'
      // for not-connected agents (setup screen) or 'activity' once connected.
      navigate(`/agents/${agent.id}`);
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
      onClick={() => {
        if (busy) return;
        // P1.B: backdrop click inside browser sub-view returns to form, not closes modal.
        if (showBrowser) {
          setShowBrowser(false);
          return;
        }
        onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`relative w-full ${showBrowser ? 'max-w-2xl' : 'max-w-md'} rounded-sm border border-border-soft bg-surface p-5 shadow-deep`}
        onClick={(e) => e.stopPropagation()}
      >
        {showBrowser ? (
          /* --- Body swap: pick a parent dir; <parent>/<id> becomes the home --- */
          <>
            {/* Header: title + explicit Back button so there's always a visible exit */}
            <div className="mb-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowBrowser(false)}
                disabled={busy}
                className="chrome flex items-center min-h-[44px] min-w-[44px] justify-center shrink-0 text-text-muted hover:text-text disabled:opacity-40"
                aria-label="Back to form"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="font-serif text-[15px] font-semibold text-text">
                Choose parent folder
              </span>
            </div>
            <DirectoryPicker
              startPath={customParent || undefined}
              onChoose={(parent) => {
                setCustomParent(parent);
                setShowBrowser(false);
                setError(null);
              }}
              onCancel={() => setShowBrowser(false)}
            />
          </>
        ) : (
          /* --- Default: add agent form --- */
          <>
            <div className="mb-4 font-serif text-[17px] font-semibold text-text">Add agent</div>
            <form onSubmit={handleSubmit} className="space-y-3">
              {/* Name */}
              <div>
                <label className="mb-1 block font-sans text-[11px] uppercase tracking-wide text-text-subtle">
                  Name
                </label>
                <input
                  ref={nameInputRef}
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                  onBlur={() => setNameTouched(true)}
                  placeholder="e.g. Tess"
                  disabled={busy}
                  className={[
                    'w-full rounded-sm bg-muted/30 px-3 py-1.5 font-sans text-[14px] text-text placeholder:text-text-subtle focus:outline-none',
                    nameTouched && !derivedId
                      ? 'border border-health-error/50 focus:ring-1 focus:ring-health-error/40'
                      : derivedId
                        ? 'border border-border focus:ring-1 focus:ring-ring'
                        : 'border border-border',
                  ].join(' ')}
                />
              </div>

              {/* Role — identity seed */}
              <div>
                <label className="mb-1 block font-sans text-[11px] uppercase tracking-wide text-text-subtle">
                  Role
                </label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value);
                    setError(null);
                  }}
                  placeholder="e.g. Product manager"
                  disabled={busy}
                  className="w-full rounded-sm border border-border bg-muted/30 px-3 py-1.5 font-sans text-[14px] text-text placeholder:text-text-subtle focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              {/* Home — auto-created preview + optional parent override */}
              <div>
                <label className="mb-1 block font-sans text-[11px] uppercase tracking-wide text-text-subtle">
                  Home
                </label>
                <div className="flex items-start gap-2 rounded-sm border border-border bg-muted/30 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    {previewPath ? (
                      <span
                        className="block truncate font-mono text-[11px] text-text"
                        title={previewPath}
                      >
                        {previewPath}
                      </span>
                    ) : (
                      <span className="block font-serif italic text-[12px] text-text-subtle">
                        Enter a name to preview path
                      </span>
                    )}
                    <span className="font-sans text-[10px] text-text-subtle">will be created</span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setShowBrowser(true)}
                      className="min-h-[44px] flex items-center font-sans text-[11px] text-accent hover:underline disabled:opacity-40"
                    >
                      Change location
                    </button>
                    {customParent !== null && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setCustomParent(null)}
                        className="font-sans text-[10px] text-text-muted hover:text-text disabled:opacity-40"
                      >
                        Reset to default
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Provider + Model + Effort */}
              <div className={[
                'grid grid-cols-1 gap-3 sm:gap-2',
                (currentProvider?.reasoningEfforts ?? []).length > 0 ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
              ].join(' ')}>
                <div>
                  <label className="mb-1 block font-sans text-[11px] uppercase tracking-wide text-text-subtle">
                    Provider
                  </label>
                  <Select
                    value={providerKind}
                    onValueChange={(v) => { if (v) handleProviderChange(v as ProviderCatalogEntry['kind']); }}
                    disabled={busy}
                  >
                    <SelectTrigger className="h-8 w-full font-sans text-[13px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {providerOptions.map((o) => (
                        <SelectItem
                          key={o.kind}
                          value={o.kind}
                          disabled={!providerReady(o, providerAvailability)}
                        >
                          {o.label}{providerUnavailableLabel(o, providerAvailability) ? ` — ${providerUnavailableLabel(o, providerAvailability)}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedProviderHint && (
                    <div className="mt-1 font-sans text-[11px] leading-snug text-text-muted">
                      {selectedProviderHint}
                    </div>
                  )}
                  {unavailableProviders.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {unavailableProviders.map((provider) => (
                        <div
                          key={provider.kind}
                          className="font-sans text-[10px] leading-snug text-text-subtle"
                        >
                          <span className="font-semibold text-text-muted">{provider.label}</span>{' '}
                          <span>{provider.status}</span>
                          {' — '}
                          <span>{provider.hint}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label className="mb-1 block font-sans text-[11px] uppercase tracking-wide text-text-subtle">
                    Model
                  </label>
                  <Select
                    value={model}
                    onValueChange={(v) => { if (v) setModel(v); }}
                    disabled={busy || !currentProvider || !selectedProviderReady}
                  >
                    <SelectTrigger className="h-8 w-full font-sans text-[13px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(currentProvider?.models ?? []).map((m) => (
                        <SelectItem key={m} value={m}>
                          {providerValueLabel(m)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {(currentProvider?.reasoningEfforts ?? []).length > 0 && (
                  <div>
                    <label className="mb-1 block font-sans text-[11px] uppercase tracking-wide text-text-subtle">
                      Effort
                    </label>
                    <Select
                      value={effort}
                      onValueChange={(v) => { if (v) setEffort(v); }}
                      disabled={busy || !selectedProviderReady}
                    >
                      <SelectTrigger className="h-8 w-full font-sans text-[13px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(currentProvider?.reasoningEfforts ?? []).map((e) => (
                          <SelectItem key={e} value={e}>
                            {providerValueLabel(e)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {error && (
                <div className="font-sans text-[12px] leading-snug text-health-error">{error}</div>
              )}
              {providerAvailabilityError && (
                <div className="font-sans text-[12px] leading-snug text-health-error">
                  Provider check failed: {providerAvailabilityError instanceof Error ? providerAvailabilityError.message : String(providerAvailabilityError)}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !derivedId ||
                    !role.trim() ||
                    !providerKind ||
                    !model ||
                    !selectedProviderReady
                  }
                >
                  {busy ? 'Adding…' : 'Add agent'}
                </Button>
                <Button type="button" onClick={onClose} variant="outline" disabled={busy}>
                  Cancel
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
