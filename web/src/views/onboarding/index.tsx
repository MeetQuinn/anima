import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
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
import {
  FeishuOnboardingConnect,
  type FeishuOnboardingPhase,
} from '@/views/agents/profile/FeishuOnboardingConnect';
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
              ? 'border-accent bg-accent text-white'
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
  onChoose,
  saving,
  value,
}: {
  error?: string;
  onChoose: (platform: WorkspacePlatform) => void;
  saving: boolean;
  value: WorkspacePlatform;
}) {
  // Platform is a one-time, remembered workspace choice. Click a card to pick
  // and advance in a single action (no separate Confirm) so first-run stays
  // fast. The pending highlight only appears on the card being saved.
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <PlatformCard
          label="Slack"
          platform="slack"
          disabled={saving}
          pending={saving && value === 'slack'}
          enterClassName="animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 delay-150 motion-reduce:animate-none"
          onChoose={() => onChoose('slack')}
        />
        <PlatformCard
          label="Feishu"
          platform="feishu"
          disabled={saving}
          pending={saving && value === 'feishu'}
          enterClassName="animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 delay-200 motion-reduce:animate-none"
          onChoose={() => onChoose('feishu')}
        />
      </div>
      {error && (
        <p className="font-sans mt-4 text-center text-[12px] text-health-error">{error}</p>
      )}
    </div>
  );
}

// Faint brand-tinted hover glow so each card has its own identity through
// light, not words. Resting state stays neutral; the warm accent is reserved
// for the chosen (pending) state, so hover and selected never collide.
const PLATFORM_BRAND_HOVER: Record<WorkspacePlatform, string> = {
  slack:
    'hover:border-[#4A154B]/45 hover:shadow-[0_10px_26px_-12px_rgba(74,21,75,0.55)]',
  feishu:
    'hover:border-[#3370FF]/45 hover:shadow-[0_10px_26px_-12px_rgba(51,112,255,0.55)]',
};

function PlatformCard({
  disabled,
  enterClassName,
  label,
  onChoose,
  pending,
  platform,
}: {
  disabled: boolean;
  enterClassName?: string;
  label: string;
  onChoose: () => void;
  pending: boolean;
  platform: WorkspacePlatform;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={disabled}
      className={[
        'group relative flex flex-col items-center gap-3.5 rounded-lg border px-4 py-8 text-center transition-all duration-200',
        enterClassName ?? '',
        pending
          ? 'border-accent bg-accent-soft/40 shadow-sm'
          : `border-border-soft bg-surface hover:-translate-y-0.5 hover:bg-surface-elevated ${PLATFORM_BRAND_HOVER[platform]}`,
        disabled && !pending ? 'opacity-50' : '',
        disabled ? 'cursor-wait' : 'cursor-pointer active:translate-y-0 active:scale-[0.98]',
      ].join(' ')}
    >
      <span
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-md bg-white shadow-sm ring-1 ring-border-soft transition-transform duration-200 group-hover:scale-105"
      >
        {platform === 'slack' ? (
          <SlackAppIcon className="h-7 w-7" />
        ) : (
          <FeishuAppIcon className="h-7 w-7" />
        )}
      </span>
      <span className="font-sans text-[13px] font-medium tracking-wide text-text-muted">
        {label}
      </span>
      {pending && (
        <span className="absolute right-2.5 top-2.5" aria-hidden>
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
        </span>
      )}
    </button>
  );
}

function SlackAppIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 2447.6 2452.5" xmlns="http://www.w3.org/2000/svg">
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

// Feishu's CURRENT brand mark (the blue+teal flying bird; Feishu rebranded
// away from the older origami paper-plane+pen-tip around 2021). The official
// colored vector isn't published publicly — icon CDNs carry only the "Lark"
// wordmark or monochrome glyphs — so this is the official raster pulled from
// feishu.cn (256px, transparent), served from /public. Swap to the official
// brand-kit SVG if/when we obtain one; the interface stays the same.
function FeishuAppIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <img
      src="/feishu-logo.png"
      alt="Feishu"
      className={className}
      draggable={false}
    />
  );
}

export function AgentCreateFlow({ firstRun, onClose, onComplete }: AgentCreateFlowProps) {
  const queryClient = useQueryClient();
  // Optional preview params for dev/screenshot use
  const previewSearch = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
  const previewStepRaw = Number(previewSearch.get('_previewStep') ?? 0);
  const previewFeishuPhase = (previewSearch.get('_previewFeishu') as FeishuOnboardingPhase | null) ?? undefined;
  const previewPlatform = (previewSearch.get('_previewPlatform') as WorkspacePlatform | null) ?? undefined;
  const previewStepName = previewSearch.get('_previewStep');
  const previewStep: FlowStep | undefined =
    previewFeishuPhase ? 'connect'
      : previewStepName === 'platform' ? 'platform'
        : previewStepRaw === 1 ? 'agent'
          : previewStepRaw === 2 ? 'connect'
            : previewStepRaw === 3 ? 'owner' : undefined;

  const [step, setStep] = useState<FlowStep>(previewStep ?? (firstRun ? 'platform' : 'agent'));
  const [workspacePlatform, setWorkspacePlatform] = useState<WorkspacePlatform>(
    previewFeishuPhase ? 'feishu' : previewPlatform ?? 'slack',
  );
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
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(
    previewFeishuPhase ? 'preview-agent' : null,
  );
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Feishu connect sub-phase, reported up by FeishuOnboardingConnect.
  const [feishuPhase, setFeishuPhase] = useState<FeishuOnboardingPhase | undefined>(previewFeishuPhase);

  const nameInputRef = useRef<HTMLInputElement>(null);
  // Tab opened synchronously inside the Feishu submit handler so the browser
  // treats it as user-initiated (popup-safe); FeishuOnboardingConnect points it
  // at the Feishu authorization URL once registration returns one.
  const feishuAuthWindowRef = useRef<Window | null>(null);

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
  // Platform is a pre-step fork, not a numbered step. Each platform gets its own
  // numbered sequence (Slack: agent → connect → owner; Feishu: agent → connect),
  // so the two flows no longer share a stepper count.
  const numberedSteps = useMemo<FlowStep[]>(() => {
    const tail: FlowStep[] = workspacePlatform === 'slack' ? ['connect', 'owner'] : ['connect'];
    return ['agent', ...tail];
  }, [workspacePlatform]);
  const onPlatformFork = step === 'platform';
  const currentStepIndex = Math.max(0, numberedSteps.indexOf(step));
  // When Feishu reaches its connected moment, the whole sequence reads done so
  // the success check never sits under an active (red) step dot.
  const feishuAllDone = workspacePlatform === 'feishu' && feishuPhase === 'connected';
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

  // Auto-focus the name field whenever we land on the agent step. Keyed to
  // `step` (not mount): on first-run the component mounts on the platform fork,
  // so the input doesn't exist yet — focus only once it's rendered.
  useEffect(() => {
    if (step !== 'agent') return;
    const t = setTimeout(() => nameInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [step]);

  useEffect(() => {
    if (previewPlatform || previewFeishuPhase) return;
    if (!savedWorkspacePlatform) return;
    if (workspacePlatformTouched) return;
    const timer = setTimeout(() => setWorkspacePlatform(savedWorkspacePlatform), 0);
    return () => clearTimeout(timer);
  }, [savedWorkspacePlatform, workspacePlatformTouched, previewPlatform, previewFeishuPhase]);

  useEffect(() => {
    if (step === 'platform' || numberedSteps.includes(step)) return;
    const timer = setTimeout(() => setStep(numberedSteps[numberedSteps.length - 1] ?? 'agent'), 0);
    return () => clearTimeout(timer);
  }, [step, numberedSteps]);

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

  async function persistPlatform(next: WorkspacePlatform) {
    if (platformSaving) return;
    setPlatformSaving(true);
    setPlatformError(undefined);
    try {
      // Keep the chosen-card "settle" beat visible even when the save is
      // instant (e.g. local dev), so the selection registers before the next
      // step slides in. Sub-250ms reads as polish, not friction.
      const [savedPlatform] = await Promise.all([
        saveWorkspacePlatform(next),
        new Promise((resolve) => setTimeout(resolve, 220)),
      ]);
      setWorkspacePlatform(savedPlatform);
      queryClient.setQueryData(queryKeys.workspacePlatform(), savedPlatform);
      setStep('agent');
    } catch (err) {
      setPlatformError(err instanceof Error ? err.message : 'Failed to save workspace platform');
    } finally {
      setPlatformSaving(false);
    }
  }

  // Click-to-advance: pick the platform and persist in one action (no Confirm).
  function handlePlatformChoose(next: WorkspacePlatform) {
    if (platformSaving) return;
    setWorkspacePlatformTouched(true);
    setWorkspacePlatform(next);
    void persistPlatform(next);
  }

  async function handleCreate() {
    setNameTouched(true);
    if (!derivedId || !role.trim() || !selectedProviderReady) return;

    // Feishu auto-start: open the authorization tab synchronously, inside this
    // click, so the browser does not block it. FeishuOnboardingConnect points it
    // at the real auth URL once registration returns one. A no-URL/failed start
    // closes it back down via the fallback path.
    if (workspacePlatform === 'feishu') {
      feishuAuthWindowRef.current = window.open('', '_blank');
    }

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
          {/* Very weak escape hatch back to the platform choice. Only on the
              first numbered step during first-run — that's the one step whose
              "back" target (the platform fork) has no step dot. Platform is a
              remembered global choice, so this stays deliberately faint. */}
          {step === 'agent' && firstRun && (
            <button
              onClick={() => setStep('platform')}
              className="-ml-1.5 flex h-7 w-7 items-center justify-center rounded-sm text-text-subtle transition-colors hover:bg-surface-elevated hover:text-text-muted"
              title="Back to platform"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {/* Step indicator — hidden on the platform fork (a pre-step choice) */}
          {!onPlatformFork && (
            <div className="flex items-center gap-1">
              {numberedSteps.map((entry, index) => (
                <StepDot
                  key={entry}
                  n={index + 1}
                  current={feishuAllDone ? numberedSteps.length + 1 : currentStepIndex + 1}
                  done={feishuAllDone || index < currentStepIndex}
                  last={index === numberedSteps.length - 1}
                  onClick={index < currentStepIndex ? () => setStep(entry) : undefined}
                />
              ))}
            </div>
          )}
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

      {/* Platform fork renders as its own welcome surface (see firstRun shell),
          not inside this card chrome. */}

      {/* ---- Step: Create agent + home ---- */}
      {step === 'agent' && (
        <div className="animate-in fade-in slide-in-from-right-4 fill-mode-both duration-300 motion-reduce:animate-none px-6 py-6">
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
          <FeishuOnboardingConnect
            agentId={createdAgentId}
            agentName={name.trim()}
            getAuthWindow={() => feishuAuthWindowRef.current}
            previewPhase={previewFeishuPhase}
            onPhaseChange={setFeishuPhase}
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
        {onPlatformFork ? (
          // Platform fork = the brand arrival moment. No card chrome: the
          // wordmark, the positioning line, and the two choices breathe on the
          // open surface so the first screen reads as arriving somewhere, not a
          // dialog. Everything bends to staying fast (one click advances).
          <div className="flex min-h-full w-full flex-col items-center justify-center px-4 py-12">
            <div className="flex w-full max-w-md flex-col items-center text-center">
              <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none flex items-center justify-center gap-2.5">
                <AnimaIcon className="h-8 w-8 text-accent" />
                <span className="font-serif text-[34px] font-semibold leading-none text-text">Anima</span>
              </div>
              <p className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 delay-75 motion-reduce:animate-none mt-4 max-w-sm text-balance font-serif text-[15px] leading-relaxed text-text-muted">
                AI teammates in your chat, building shared team context.
              </p>

              {/* Clear boundary: the brand arrival above, the actual choice
                  below. A faint rule + the question caption bound tightly to the
                  cards so the two blocks no longer blur together. */}
              <span
                aria-hidden
                className="animate-in fade-in fill-mode-both duration-500 delay-100 motion-reduce:animate-none mt-11 h-px w-8 bg-border-strong/50"
              />
              <p className="animate-in fade-in fill-mode-both duration-500 delay-100 motion-reduce:animate-none mt-5 font-sans text-[11px] font-semibold uppercase tracking-[0.18em] text-text-subtle">
                Where does your team work?
              </p>
              <div className="mt-3 w-full">
                <WorkspacePlatformStep
                  error={platformError}
                  onChoose={handlePlatformChoose}
                  saving={platformSaving}
                  value={workspacePlatform}
                />
              </div>
            </div>
          </div>
        ) : (
          // fixed inset-0 + overflow-y-auto sidesteps body { overflow: hidden }
          // so the page scrolls when content (e.g. Slack connect steps) is
          // taller than the viewport.
          <div className="flex min-h-full w-full flex-col items-center justify-center gap-6 px-4 py-12">
            {/* Compact wordmark above the working steps (the arrival/tagline
                moment lives on the platform fork only). */}
            <div className="animate-in fade-in fill-mode-both duration-500 motion-reduce:animate-none flex items-center justify-center gap-2">
              <AnimaIcon className="h-6 w-6 text-accent" />
              <span className="font-serif text-[22px] font-semibold text-text">Anima</span>
            </div>
            {card}
          </div>
        )}
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
