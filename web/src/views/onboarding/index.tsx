import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { awaitAgentsRefresh, createAgent, refreshDashboardData, updateAgentProfile } from '@/api/agents';
import { fetchProviderAvailability } from '@/api/system';
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_PROVIDER_KIND,
  providerCatalog,
  type ProviderCatalogEntry,
} from '@shared/provider-catalog';
import { DEFAULT_AGENT_HOMES_ROOT, defaultAgentHomePath } from '@shared/agent-home';
import { agentIdFromName } from '@shared/agent-config';
import {
  firstReadyProvider,
  providerReady,
  providerUnavailableHint,
  unavailableProviderHints,
} from '@/lib/provider-availability';
import AnimaIcon from '@/components/AnimaIcon';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import DirectoryPicker from '@/components/DirectoryPicker';
import { SlackConnectStepper } from '@/views/agents/profile/SlackConnectStepper';
import { OwnerPickerForm } from '@/views/agents/profile/OwnerPickerForm';
import { queryKeys } from '@/lib/query-keys';

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepDot({
  n,
  current,
  done,
  onClick,
}: {
  n: number;
  current: number;
  done: boolean;
  onClick?: () => void;
}) {
  const isActive = n === current;
  return (
    <div className="flex items-center gap-2">
      <span
        onClick={onClick}
        title={onClick ? 'Go back to this step' : undefined}
        className={[
          'font-sans flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors',
          done
            ? 'border-health-ok bg-health-ok-soft text-health-ok'
            : isActive
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border-soft text-text-subtle',
          onClick ? 'cursor-pointer hover:opacity-60' : '',
        ].join(' ')}
      >
        {n}
      </span>
      {n < 3 && (
        <span className={['h-px w-8 transition-colors', n < current ? 'bg-health-ok/40' : 'bg-border-soft'].join(' ')} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentCreateFlow
// ---------------------------------------------------------------------------

interface AgentCreateFlowProps {
  firstRun: boolean;
  onClose: () => void;
  onComplete?: (agentId: string) => void;
}

type FlowStep = 1 | 2 | 3;

export function AgentCreateFlow({ firstRun, onClose, onComplete }: AgentCreateFlowProps) {
  // Optional preview param for dev/screenshot use
  const previewStepRaw = typeof window !== 'undefined'
    ? Number(new URLSearchParams(window.location.search).get('_previewStep') ?? 0)
    : 0;
  const previewStep: FlowStep | undefined =
    previewStepRaw === 2 ? 2 : previewStepRaw === 3 ? 3 : undefined;

  const [step, setStep] = useState<FlowStep>(previewStep ?? 1);

  // Step 1 state
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [role, setRole] = useState('');
  const [providerKind, setProviderKind] = useState<ProviderCatalogEntry['kind']>(DEFAULT_PROVIDER_KIND);
  const [model, setModel] = useState(
    providerCatalog().find((o) => o.kind === DEFAULT_PROVIDER_KIND)?.defaultModel ?? '',
  );
  const [effort, setEffort] = useState(DEFAULT_REASONING_EFFORT);

  // Home section state
  const [homeExpanded, setHomeExpanded] = useState(false);
  const [customParent, setCustomParent] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  // Create state
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const nameInputRef = useRef<HTMLInputElement>(null);

  const {
    data: providerAvailability,
    error: providerAvailabilityError,
  } = useQuery({
    queryKey: queryKeys.providerAvailability(),
    queryFn: fetchProviderAvailability,
  });

  const providerOptions = useMemo(() => providerCatalog(), []);
  const derivedId = agentIdFromName(name.trim());

  // Display helpers — Base UI SelectValue shows raw value before items register;
  // use render-prop form to always resolve a human label.
  const displayProvider = (v: string) => providerOptions.find((r) => r.kind === v)?.label ?? v;
  const displayModel = (v: string) => v ? v.charAt(0).toUpperCase() + v.slice(1) : v;
  const displayEffort = (v: string) => v === 'xhigh' ? 'Extra High' : (v ? v.charAt(0).toUpperCase() + v.slice(1) : v);
  const currentProvider = providerOptions.find((o) => o.kind === providerKind);
  const selectedProviderReady = providerReady(currentProvider, providerAvailability);
  const selectedProviderHint = providerUnavailableHint(currentProvider, providerAvailability);
  const unavailableProviders = unavailableProviderHints(providerOptions, providerAvailability);
  const providerCheckPending = !providerAvailability && !providerAvailabilityError;

  const homePath = derivedId
    ? defaultAgentHomePath(derivedId, customParent ?? DEFAULT_AGENT_HOMES_ROOT)
    : `${customParent ?? DEFAULT_AGENT_HOMES_ROOT}/<name>`;

  // Auto-select a ready provider when availability resolves.
  useEffect(() => {
    if (!providerAvailability) return;
    if (providerReady(providerOptions.find((o) => o.kind === providerKind), providerAvailability)) return;
    const next = firstReadyProvider(providerOptions, providerAvailability);
    if (!next) return;
    setTimeout(() => {
      setProviderKind(next.kind);
      setModel(next.defaultModel);
    }, 0);
  }, [providerAvailability, providerKind, providerOptions]);

  useEffect(() => {
    setTimeout(() => nameInputRef.current?.focus(), 50);
  }, []);

  const handleClose = useCallback(() => {
    if (createdAgentId) refreshDashboardData();
    onClose();
  }, [createdAgentId, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || creating) return;
      if (showPicker) { setShowPicker(false); return; }
      handleClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose, creating, showPicker]);

  function handleProviderChange(next: ProviderCatalogEntry['kind']) {
    setProviderKind(next);
    setModel(providerOptions.find((o) => o.kind === next)?.defaultModel ?? '');
    setEffort(DEFAULT_REASONING_EFFORT);
  }

  async function handleCreate() {
    setNameTouched(true);
    if (!derivedId || !role.trim() || !selectedProviderReady) return;
    setCreating(true);
    setCreateError(null);

    // Agent already created (user went back to edit name/role) — update profile and advance.
    if (createdAgentId) {
      try {
        await updateAgentProfile(createdAgentId, { displayName: name.trim(), role: role.trim() });
        refreshDashboardData();
        setStep(2);
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : 'Failed to update agent');
      } finally {
        setCreating(false);
      }
      return;
    }

    const provider = {
      kind: providerKind,
      model,
      ...((currentProvider?.reasoningEfforts ?? []).length > 0 ? { reasoningEffort: effort } : {}),
    };
    try {
      const agent = await createAgent({
        name: name.trim(),
        role: role.trim(),
        homePath,
        provider,
      });
      setCreatedAgentId(agent.id);
      setStep(2);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setCreating(false);
    }
  }

  async function handleSlackConnected() {
    // Await the agents refetch so AgentReconciler sees the new agent before
    // we navigate — otherwise it redirects to a different agent (stale cache).
    await awaitAgentsRefresh();
    setStep(3);
  }

  function handleOwnerComplete() {
    if (createdAgentId) onComplete?.(createdAgentId);
  }

  const stepTitle =
    step === 1 ? 'Create your agent' :
    step === 2 ? 'Connect to Slack' :
    'Assign owner';
  const createDisabledReason = (() => {
    if (creating) return undefined;
    if (!derivedId) return 'Enter a name';
    if (!role.trim()) return 'Enter a role';
    if (providerAvailabilityError) return 'Provider check failed';
    if (providerCheckPending) return 'Checking providers...';
    if (!selectedProviderReady) return 'Install a provider first';
    return undefined;
  })();

  // -------------------------------------------------------------------------
  // Directory picker overlay
  // -------------------------------------------------------------------------

  if (showPicker) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm">
        <div className="relative w-full max-w-2xl rounded-sm border border-border-soft bg-surface shadow-deep">
          <div className="flex items-center justify-between border-b border-border-soft px-5 py-4">
            <span className="font-serif text-[15px] font-semibold text-text">Choose home folder</span>
            <button
              onClick={() => setShowPicker(false)}
              className="flex h-8 w-8 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-5">
            <DirectoryPicker
              onChoose={(dir) => {
                setCustomParent(dir);
                setShowPicker(false);
              }}
              onCancel={() => setShowPicker(false)}
            />
          </div>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Card content
  // -------------------------------------------------------------------------

  const card = (
    <div className="relative w-full max-w-xl rounded-sm border border-border-soft bg-white shadow-deep">

      {/* hero lives outside the card now — see shell below */}

      {/* ---- Card header row ---- */}
      <div className="flex items-center justify-between border-b border-border-soft px-6 py-4">
        <div className="flex items-center gap-3">
          {/* Step indicator */}
          <div className="flex items-center gap-1">
            <StepDot n={1} current={step} done={step > 1} onClick={step > 1 ? () => setStep(1) : undefined} />
            <StepDot n={2} current={step} done={step > 2} />
            <StepDot n={3} current={step} done={false} />
          </div>
          {/* Step title */}
          <span className="font-serif text-[15px] font-semibold text-text">{stepTitle}</span>
        </div>
        {/* X close — hidden on first-run before any agent is created (no destination behind it) */}
        {(!firstRun || createdAgentId) && (
          <button
            onClick={handleClose}
            className="flex h-8 w-8 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ---- Step 1 — Create agent + home ---- */}
      {step === 1 && (
        <div className="px-6 py-6">
          <div className="space-y-4">
            {/* Name */}
            <div>
              <label className="font-sans mb-1.5 block text-[12px] font-medium uppercase tracking-[0.08em] text-text-muted">
                Name
              </label>
              <input
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
                placeholder="e.g. Aria"
                className="w-full rounded-sm border border-border-soft bg-surface px-3 py-2 font-serif text-[15px] text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
              />
              {nameTouched && !derivedId && (
                <p className="font-sans mt-1 text-[11px] text-health-error">Name must include at least one letter or number.</p>
              )}
            </div>

            {/* Role */}
            <div>
              <label className="font-sans mb-1.5 block text-[12px] font-medium uppercase tracking-[0.08em] text-text-muted">
                Role
              </label>
              <input
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
                placeholder="e.g. Full-stack developer"
                className="w-full rounded-sm border border-border-soft bg-surface px-3 py-2 font-serif text-[15px] text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
              />
            </div>

            {/* Provider */}
            <div>
              <label className="font-sans mb-1.5 block text-[12px] font-medium uppercase tracking-[0.08em] text-text-muted">
                Provider
              </label>
              {providerAvailability && unavailableProviders.length === providerOptions.length ? (
                <p className="font-sans text-[12px] text-health-warn">
                  No providers detected. Install Claude Code, Codex CLI, or Kimi CLI first.
                </p>
              ) : (
                <div className={[
                  'grid gap-2',
                  (currentProvider?.reasoningEfforts ?? []).length > 0 ? 'grid-cols-3' : 'grid-cols-2',
                ].join(' ')}>
                  <Select value={providerKind} onValueChange={(v) => handleProviderChange(v as ProviderCatalogEntry['kind'])}>
                    <SelectTrigger className="!h-auto w-full py-2 font-serif text-[15px]">
                      <SelectValue>{(v: string) => displayProvider(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {providerOptions.map((r) => {
                        const hint = providerUnavailableHint(r, providerAvailability);
                        return (
                          <SelectItem key={r.kind} value={r.kind} disabled={!!hint}>
                            {r.label}{hint ? ` — ${hint}` : ''}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <Select value={model} onValueChange={(v) => { if (v) setModel(v); }}>
                    <SelectTrigger className="!h-auto w-full py-2 font-serif text-[15px]">
                      <SelectValue>{(v: string) => displayModel(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(currentProvider?.models ?? []).map((m) => (
                        <SelectItem key={m} value={m}>{displayModel(m)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {(currentProvider?.reasoningEfforts ?? []).length > 0 && (
                    <Select value={effort} onValueChange={(v) => { if (v) setEffort(v); }}>
                      <SelectTrigger className="!h-auto w-full py-2 font-serif text-[15px]">
                        <SelectValue>{(v: string) => displayEffort(v)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(currentProvider?.reasoningEfforts ?? []).map((e) => (
                          <SelectItem key={e} value={e}>{displayEffort(e)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
              {selectedProviderHint && (
                <p className="font-sans mt-1 text-[11px] text-health-warn">{selectedProviderHint}</p>
              )}
              {providerCheckPending && (
                <p className="font-sans mt-1 text-[11px] text-text-subtle">Checking installed provider CLIs...</p>
              )}
              {providerAvailabilityError && (
                <p className="font-sans mt-1 text-[11px] text-health-error">
                  Provider check failed: {providerAvailabilityError instanceof Error ? providerAvailabilityError.message : String(providerAvailabilityError)}
                </p>
              )}
            </div>

            {/* Home — collapsed secondary field; hidden when agent already created (dir exists) */}
            {!createdAgentId && <div>
              <button
                type="button"
                onClick={() => setHomeExpanded((v) => !v)}
                className="font-sans flex items-center gap-1 text-[12px] text-text-muted hover:text-text transition-colors"
              >
                {homeExpanded
                  ? <ChevronDown className="h-3.5 w-3.5" />
                  : <ChevronRight className="h-3.5 w-3.5" />
                }
                Where it lives
              </button>

              {homeExpanded && (
                <div className="mt-2 rounded-sm border border-border-soft bg-surface-elevated p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-[13px] text-text break-all">{homePath}</div>
                      <div className="font-sans mt-0.5 text-[11px] text-text-subtle">
                        Will be created automatically
                      </div>
                      <p className="font-sans mt-2 text-[12px] text-text-muted">
                        Your agent's memory lives here, inside your team's <strong className="font-semibold text-text">Knowledge Base</strong>.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowPicker(true)}
                      className="font-sans shrink-0 text-[12px] text-text-muted underline decoration-text-muted/40 underline-offset-2 hover:text-text hover:decoration-text/40 transition-colors"
                    >
                      Change…
                    </button>
                  </div>
                  {customParent && (
                    <button
                      type="button"
                      onClick={() => setCustomParent(null)}
                      className="font-sans mt-2 text-[11px] text-text-subtle underline underline-offset-2 hover:text-text transition-colors"
                    >
                      Reset to default
                    </button>
                  )}
                </div>
              )}
            </div>}
          </div>

          {createError && (
            <p className="font-sans mt-3 text-[12px] text-health-error">{createError}</p>
          )}

          <div className="mt-6">
            <Button
              className="w-full"
              onClick={() => void handleCreate()}
              disabled={creating || !!createDisabledReason}
            >
              {creating
                ? (createdAgentId ? 'Saving…' : 'Creating…')
                : (createDisabledReason ?? (createdAgentId ? 'Save & continue →' : 'Create agent →'))}
            </Button>
          </div>
        </div>
      )}

      {/* ---- Step 2 — Connect Slack ---- */}
      {step === 2 && createdAgentId && (
        <div className="px-6 py-6">
          <SlackConnectStepper agentId={createdAgentId} onConnect={handleSlackConnected} />
        </div>
      )}

      {/* ---- Step 3 — Assign Owner ---- */}
      {step === 3 && createdAgentId && (
        <div className="px-6 py-6">
          <OwnerPickerForm
            agentId={createdAgentId}
            onConfirm={handleOwnerComplete}
            onSkip={handleOwnerComplete}
            submitLabel="Start onboarding →"
            showRationale
          />
        </div>
      )}
    </div>
  );

  // -------------------------------------------------------------------------
  // Full-screen shell vs bare card
  // -------------------------------------------------------------------------

  if (firstRun) {
    return (
      // fixed inset-0 + overflow-y-auto sidesteps body { overflow: hidden } so
      // the page scrolls when content (e.g. Slack connect steps) is taller than
      // the viewport.
      <div className="fixed inset-0 overflow-y-auto bg-surface">
        <div className="flex min-h-full w-full flex-col items-center justify-center gap-6 px-4 pt-8 pb-[20vh]">
          {/* Wordmark above the card — shown on both steps; tagline only on step 1 */}
          <div className="text-center">
            <div className="flex items-center justify-center gap-2">
              <AnimaIcon className="h-6 w-6 text-accent" />
              <span className="font-serif text-[26px] font-semibold text-text">Anima</span>
            </div>
            <p className="font-sans mt-2 max-w-sm text-balance text-[13px] leading-relaxed text-text-muted">
              An AI agent team that works alongside your human team in Slack, building up shared knowledge over time.
            </p>
          </div>
          {card}
        </div>
      </div>
    );
  }

  return card;
}

// ---------------------------------------------------------------------------
// OnboardingPage — full-screen first-run route
// ---------------------------------------------------------------------------

export function OnboardingPage() {
  const navigate = useNavigate();
  return (
    <AgentCreateFlow
      firstRun={true}
      onClose={() => navigate('/')}
      onComplete={(id) => navigate(`/agents/${id}/activity`)}
    />
  );
}

// ---------------------------------------------------------------------------
// AgentCreateModal — sidebar "Add agent" entry point
// ---------------------------------------------------------------------------

export function AgentCreateModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm">
      <AgentCreateFlow
        firstRun={false}
        onClose={onClose}
        onComplete={(id) => { onClose(); navigate(`/agents/${id}/activity`); }}
      />
    </div>
  );
}
