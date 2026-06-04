import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { awaitAgentsRefresh, createAgent, refreshDashboardData, updateAgentProfile } from '@/api/agents';
import { fetchProviderAvailability, fetchWorkspacePlatform, saveWorkspacePlatform } from '@/api/system';
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
import { FeishuConnectStepper } from '@/views/agents/profile/FeishuConnectStepper';
import { OwnerPickerForm } from '@/views/agents/profile/OwnerPickerForm';
import { queryKeys } from '@/lib/query-keys';
import type { WorkspacePlatform } from '@shared/server-settings';

const WORKSPACE_PLATFORM_LABELS: Record<WorkspacePlatform, string> = {
  feishu: 'Feishu',
  slack: 'Slack',
};

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepDot({
  last = false,
  n,
  current,
  done,
  onClick,
}: {
  last?: boolean;
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
      {!last && (
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
  onClose: (createdAgentId?: string) => void;
  onComplete?: (agentId: string) => void;
}

type FlowStep = 'agent' | 'connect' | 'owner' | 'platform';

function WorkspacePlatformStep({
  error,
  onSelect,
  saving,
  value,
}: {
  error?: string;
  onSelect: (platform: WorkspacePlatform) => void;
  saving: boolean;
  value: WorkspacePlatform;
}) {
  return (
    <div className="px-6 py-6">
      <div className="space-y-3">
        <PlatformOption
          label="Slack"
          platform="slack"
          saving={saving}
          selected={value === 'slack'}
          onSelect={() => onSelect('slack')}
        />
        <PlatformOption
          label="Feishu"
          platform="feishu"
          saving={saving}
          selected={value === 'feishu'}
          onSelect={() => onSelect('feishu')}
        />
      </div>
      {error && (
        <p className="font-sans mt-3 text-[12px] text-health-error">{error}</p>
      )}
    </div>
  );
}

function PlatformOption({
  label,
  onSelect,
  platform,
  saving,
  selected,
}: {
  label: string;
  onSelect: () => void;
  platform: WorkspacePlatform;
  saving: boolean;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={saving}
      className={[
        'w-full rounded-sm border px-4 py-3 text-left transition-colors',
        selected
          ? 'border-accent bg-accent-soft/50'
          : 'border-border-soft bg-surface hover:bg-surface-elevated',
        saving ? 'cursor-wait opacity-70' : '',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <PlatformIcon platform={platform} />
          <div className="min-w-0">
            <div className="font-serif text-[15px] font-semibold text-text">{label}</div>
          </div>
        </div>
        <span
          aria-hidden
          className={[
            'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
            selected ? 'border-accent bg-accent' : 'border-border-strong',
          ].join(' ')}
        >
          {selected && <span className="h-1.5 w-1.5 rounded-full bg-surface" />}
        </span>
      </div>
    </button>
  );
}

function PlatformIcon({ platform }: { platform: WorkspacePlatform }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-white shadow-sm ring-1 ring-border-soft"
    >
      {platform === 'slack' ? <SlackAppIcon /> : <FeishuAppIcon />}
    </span>
  );
}

function SlackAppIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 2447.6 2452.5" xmlns="http://www.w3.org/2000/svg">
      <g clipRule="evenodd" fillRule="evenodd">
        <path
          d="m897.4 0c-135.3.1-244.8 109.9-244.7 245.2-.1 135.3 109.5 245.1 244.8 245.2h244.8v-245.1c.1-135.3-109.5-245.1-244.9-245.3.1 0 .1 0 0 0m0 654h-652.6c-135.3.1-244.9 109.9-244.8 245.2-.2 135.3 109.4 245.1 244.7 245.3h652.7c135.3-.1 244.9-109.9 244.8-245.2.1-135.4-109.5-245.2-244.8-245.3z"
          fill="#36C5F0"
        />
        <path
          d="m2447.6 899.2c.1-135.3-109.5-245.1-244.8-245.2-135.3.1-244.9 109.9-244.8 245.2v245.3h244.8c135.3-.1 244.9-109.9 244.8-245.3zm-652.7 0v-654c.1-135.2-109.4-245-244.7-245.2-135.3.1-244.9 109.9-244.8 245.2v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.3z"
          fill="#2EB67D"
        />
        <path
          d="m1550.1 2452.5c135.3-.1 244.9-109.9 244.8-245.2.1-135.3-109.5-245.1-244.8-245.2h-244.8v245.2c-.1 135.2 109.5 245 244.8 245.2zm0-654.1h652.7c135.3-.1 244.9-109.9 244.8-245.2.2-135.3-109.4-245.1-244.7-245.3h-652.7c-135.3.1-244.9 109.9-244.8 245.2-.1 135.4 109.4 245.2 244.7 245.3z"
          fill="#ECB22E"
        />
        <path
          d="m0 1553.2c-.1 135.3 109.5 245.1 244.8 245.2 135.3-.1 244.9-109.9 244.8-245.2v-245.2h-244.8c-135.3.1-244.9 109.9-244.8 245.2zm652.7 0v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.2v-653.9c.2-135.3-109.4-245.1-244.7-245.3-135.4 0-244.9 109.8-244.8 245.1 0 0 0 .1 0 0"
          fill="#E01E5A"
        />
      </g>
    </svg>
  );
}

function FeishuAppIcon() {
  return (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M24 .237l-5.902 6.377a.204.204 0 00-.047.163 1.135 1.135 0 01-.312 1.051 1.146 1.146 0 01-1.649 0l-4.694 4.688.461 6.207L17.136 24 24 .237z"
        fill="#38F"
      />
      <path
        d="M23.925.4l-5.833 6.302a.19.19 0 00-.041.17 1.16 1.16 0 01-.685 1.29 1.14 1.14 0 01-1.255-.252l-4.62 4.62a.082.082 0 000 .074l.455 6.105L23.68.936 23.925.4z"
        fill="#005DE0"
      />
      <path
        d="M23.742 0l-6.376 5.895a.169.169 0 01-.163.047 1.16 1.16 0 00-1.052.32 1.14 1.14 0 000 1.64l-4.7 4.702-6.173-.461L0 6.865 23.742 0z"
        fill="#46EBD5"
      />
      <path
        d="M23.6.068l-6.302 5.84a.19.19 0 01-.17.041 1.14 1.14 0 00-1.024 1.94l-4.613 4.62a.082.082 0 01-.074 0l-6.105-.455L23.064.32 23.6.068z"
        fill="#00D0B6"
      />
    </svg>
  );
}

export function AgentCreateFlow({ firstRun, onClose, onComplete }: AgentCreateFlowProps) {
  const queryClient = useQueryClient();
  // Optional preview param for dev/screenshot use
  const previewStepRaw = typeof window !== 'undefined'
    ? Number(new URLSearchParams(window.location.search).get('_previewStep') ?? 0)
    : 0;
  const previewStep: FlowStep | undefined =
    previewStepRaw === 2 ? 'connect' : previewStepRaw === 3 ? 'owner' : undefined;

  const [step, setStep] = useState<FlowStep>(previewStep ?? (firstRun ? 'platform' : 'agent'));
  const [workspacePlatform, setWorkspacePlatform] = useState<WorkspacePlatform>('slack');
  const [workspacePlatformTouched, setWorkspacePlatformTouched] = useState(false);
  const [platformSaving, setPlatformSaving] = useState(false);
  const [platformError, setPlatformError] = useState<string | undefined>();

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
  const { data: savedWorkspacePlatform } = useQuery({
    queryKey: queryKeys.workspacePlatform(),
    queryFn: fetchWorkspacePlatform,
  });

  const providerOptions = useMemo(() => providerCatalog(), []);
  const stepOrder = useMemo<FlowStep[]>(() => {
    const tail: FlowStep[] = workspacePlatform === 'slack' ? ['connect', 'owner'] : ['connect'];
    return firstRun ? ['platform', 'agent', ...tail] : ['agent', ...tail];
  }, [firstRun, workspacePlatform]);
  const currentStepIndex = Math.max(0, stepOrder.indexOf(step));
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

  useEffect(() => {
    if (!savedWorkspacePlatform) return;
    if (workspacePlatformTouched) return;
    const timer = setTimeout(() => setWorkspacePlatform(savedWorkspacePlatform), 0);
    return () => clearTimeout(timer);
  }, [savedWorkspacePlatform, workspacePlatformTouched]);

  useEffect(() => {
    if (stepOrder.includes(step)) return;
    const timer = setTimeout(() => setStep(stepOrder[stepOrder.length - 1] ?? 'agent'), 0);
    return () => clearTimeout(timer);
  }, [step, stepOrder]);

  const handleClose = useCallback(async () => {
    if (createdAgentId) {
      refreshDashboardData();
      // Closing after Step 1 leaves a real, inert agent behind. Make sure the
      // shell sees it before we leave the flow so the user lands on that agent's
      // Profile instead of bouncing through the first-run redirect.
      await awaitAgentsRefresh().catch(() => undefined);
    }
    onClose(createdAgentId ?? undefined);
  }, [createdAgentId, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || creating) return;
      if (showPicker) { setShowPicker(false); return; }
      void handleClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose, creating, showPicker]);

  function handleProviderChange(next: ProviderCatalogEntry['kind']) {
    setProviderKind(next);
    setModel(providerOptions.find((o) => o.kind === next)?.defaultModel ?? '');
    setEffort(DEFAULT_REASONING_EFFORT);
  }

  async function handlePlatformSelect(next: WorkspacePlatform) {
    if (platformSaving) return;
    setWorkspacePlatformTouched(true);
    setWorkspacePlatform(next);
    setPlatformSaving(true);
    setPlatformError(undefined);
    try {
      const savedPlatform = await saveWorkspacePlatform(next);
      setWorkspacePlatform(savedPlatform);
      queryClient.setQueryData(queryKeys.workspacePlatform(), savedPlatform);
      setStep('agent');
    } catch (err) {
      setPlatformError(err instanceof Error ? err.message : 'Failed to save workspace platform');
    } finally {
      setPlatformSaving(false);
    }
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
        setStep('connect');
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
      setStep('connect');
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
    setStep('owner');
  }

  async function handleFeishuConnected() {
    await awaitAgentsRefresh();
    if (createdAgentId) onComplete?.(createdAgentId);
  }

  function handleOwnerComplete() {
    if (createdAgentId) onComplete?.(createdAgentId);
  }

  const stepTitle =
    step === 'platform' ? 'Where does your team work?' :
    step === 'agent' ? 'Create your agent' :
    step === 'connect' ? `Connect to ${WORKSPACE_PLATFORM_LABELS[workspacePlatform]}` :
    'Pick an owner';
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
            {stepOrder.map((entry, index) => (
              <StepDot
                key={entry}
                n={index + 1}
                current={currentStepIndex + 1}
                done={index < currentStepIndex}
                last={index === stepOrder.length - 1}
                onClick={index < currentStepIndex ? () => setStep(entry) : undefined}
              />
            ))}
          </div>
          {/* Step title */}
          <span className="font-serif text-[15px] font-semibold text-text">{stepTitle}</span>
        </div>
        {/* X close — hidden on first-run before any agent is created (no destination behind it) */}
        {(!firstRun || createdAgentId) && (
          <button
            onClick={() => void handleClose()}
            className="flex h-8 w-8 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ---- Step: Workspace platform ---- */}
      {step === 'platform' && (
        <WorkspacePlatformStep
          error={platformError}
          onSelect={(next) => void handlePlatformSelect(next)}
          saving={platformSaving}
          value={workspacePlatform}
        />
      )}

      {/* ---- Step: Create agent + home ---- */}
      {step === 'agent' && (
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

      {/* ---- Step: Connect platform ---- */}
      {step === 'connect' && createdAgentId && workspacePlatform === 'slack' && (
        <div className="px-6 py-6">
          <SlackConnectStepper agentId={createdAgentId} onConnect={handleSlackConnected} />
        </div>
      )}
      {step === 'connect' && createdAgentId && workspacePlatform === 'feishu' && (
        <div className="px-6 py-6">
          <FeishuConnectStepper
            agentId={createdAgentId}
            agentName={name.trim()}
            onConnect={() => void handleFeishuConnected()}
          />
        </div>
      )}

      {/* ---- Step: Pick Owner ---- */}
      {step === 'owner' && createdAgentId && workspacePlatform === 'slack' && (
        <div className="px-6 py-6">
          <OwnerPickerForm
            agentId={createdAgentId}
            onConfirm={handleOwnerComplete}
            onSkip={handleOwnerComplete}
            submitLabel="Start onboarding →"
            skipLabel="Start without owner →"
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
              An AI agent team that works alongside your human team in chat, building up shared knowledge over time.
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
      onClose={(createdAgentId) => navigate(createdAgentId ? `/agents/${createdAgentId}/profile` : '/')}
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
        onClose={(createdAgentId) => {
          onClose();
          if (createdAgentId) navigate(`/agents/${createdAgentId}/profile`);
        }}
        onComplete={(id) => { onClose(); navigate(`/agents/${id}/activity`); }}
      />
    </div>
  );
}
