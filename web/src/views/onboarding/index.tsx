import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  awaitAgentsRefresh,
  createAgent,
  refreshDashboardData,
  startAgentFeishuAppRegistration,
  updateAgentProfile,
} from '@/api/agents';
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
  effortOptionsForSelectedModel,
  firstReadyProvider,
  providerCatalogForAvailability,
  providerModelAuthorityLabel,
  providerReady,
  providerUnavailableHint,
  unavailableProviderHints,
} from '@/lib/provider-availability';
import AnimaIcon from '@/components/AnimaIcon';
import { StepDot, WorkspacePlatformStep } from './components';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import DirectoryPicker from '@/components/DirectoryPicker';
import { SlackConnectStepper } from '@/views/agents/profile/SlackConnectStepper';
import { FeishuOnboardingConnect, type FeishuOnboardingPhase } from '@/views/agents/profile/FeishuOnboardingConnect';
import { OwnerPickerForm } from '@/views/agents/profile/OwnerPickerForm';
import { queryKeys } from '@/lib/query-keys';
import { isFeishuRegistrationActive, useFeishuRegistrationPoll } from '@/hooks/useFeishuRegistrationPoll';
import type { AgentFeishuRegisterAppStatus } from '@shared/agent-config';
import { DEFAULT_TEAM_ID, type TeamConfig, type WorkspacePlatform } from '@shared/server-settings';

const WORKSPACE_PLATFORM_LABELS: Record<WorkspacePlatform, string> = {
  feishu: 'Feishu',
  slack: 'Slack',
};

const FEISHU_CREATE_SLOW_MS = 15_000;

// ---------------------------------------------------------------------------
// AgentCreateFlow
// ---------------------------------------------------------------------------

interface AgentCreateFlowProps {
  firstRun: boolean;
  onClose: (createdAgentId?: string) => void;
  // The team registry + the working-context team a new agent should land in. When
  // there is only the default team, no team chrome appears and behavior is
  // identical to the pre-teams flow.
  teams?: TeamConfig[];
  defaultTeamId?: string;
  onComplete?: (
    agentId: string,
    justConnected?: 'feishu',
    /**
     * True only when the connect will produce a Feishu greeting (auto-registered
     * app). The manual existing-app path is left ungreeted (#154), so it lands on
     * the activity view but must NOT arm the "say hi" banner.
     */
    greetingBanner?: boolean,
  ) => void;
}

type FlowStep = 'agent' | 'connect' | 'permissions' | 'owner' | 'platform';

export function AgentCreateFlow({ firstRun, onClose, onComplete, teams, defaultTeamId }: AgentCreateFlowProps) {
  const queryClient = useQueryClient();
  // Optional preview params for dev/screenshot use
  const previewSearch =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const previewStepRaw = Number(previewSearch.get('_previewStep') ?? 0);
  const previewFeishuPhase = (previewSearch.get('_previewFeishu') as FeishuOnboardingPhase | null) ?? undefined;
  const previewPlatform = (previewSearch.get('_previewPlatform') as WorkspacePlatform | null) ?? undefined;
  const previewCreateLoading = import.meta.env.DEV && previewSearch.get('_previewCreateLoading') === 'feishu';
  const previewCreateSlow = previewCreateLoading && previewSearch.get('_previewSlow') === '1';
  const previewStepName = previewSearch.get('_previewStep');
  const previewStep: FlowStep | undefined = previewFeishuPhase
    ? previewFeishuPhase === 'permissions' || previewFeishuPhase === 'connected'
      ? 'permissions'
      : 'connect'
    : previewStepName === 'platform'
      ? 'platform'
      : previewStepRaw === 1
        ? 'agent'
        : previewStepRaw === 2
          ? 'connect'
          : previewStepRaw === 3
            ? previewPlatform === 'feishu'
              ? 'permissions'
              : 'owner'
            : undefined;

  const [step, setStep] = useState<FlowStep>(previewStep ?? (firstRun ? 'platform' : 'agent'));
  const [workspacePlatform, setWorkspacePlatform] = useState<WorkspacePlatform>(
    previewFeishuPhase ? 'feishu' : (previewPlatform ?? 'slack'),
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

  // Team a new agent lands in. Fixed to the team the create action launched from
  // (defaultTeamId) — there is no in-modal team picker, so the agent joins
  // whichever team's sidebar it was started from.
  const teamsList = teams ?? [];
  const [teamId] = useState(defaultTeamId ?? DEFAULT_TEAM_ID);
  const selectedTeam = teamsList.find((t) => t.id === teamId);
  // The team's agents live under $TEAM_HOME/agents/. For the default team this is
  // exactly DEFAULT_AGENT_HOMES_ROOT, so N=1 create is byte-identical to today.
  const teamAgentsRoot = selectedTeam ? `${selectedTeam.home.replace(/\/+$/, '')}/agents` : DEFAULT_AGENT_HOMES_ROOT;

  // Create state
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(previewFeishuPhase ? 'preview-agent' : null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createStage, setCreateStage] = useState<'agent' | 'feishu' | undefined>();
  const [feishuCreateSlow, setFeishuCreateSlow] = useState(false);
  const [feishuRegistration, setFeishuRegistration] = useState<AgentFeishuRegisterAppStatus | null>(null);
  const [feishuRegistrationError, setFeishuRegistrationError] = useState<string | undefined>();

  // Feishu connect sub-phase, reported up by FeishuOnboardingConnect.
  const [feishuPhase, setFeishuPhase] = useState<FeishuOnboardingPhase | undefined>(previewFeishuPhase);
  const [feishuConnectSource, setFeishuConnectSource] = useState<'registerApp' | 'manual' | null>(
    previewFeishuPhase === 'permissions' || previewFeishuPhase === 'connected' ? 'registerApp' : null,
  );

  const nameInputRef = useRef<HTMLInputElement>(null);
  const createRunRef = useRef(0);
  const feishuSlowTimerRef = useRef<number | null>(null);

  const { data: providerAvailability, error: providerAvailabilityError } = useQuery({
    queryKey: queryKeys.providerAvailability(),
    queryFn: fetchProviderAvailability,
  });
  const { data: savedWorkspacePlatform } = useQuery({
    queryKey: queryKeys.workspacePlatform(),
    queryFn: fetchWorkspacePlatform,
  });

  const providerOptions = useMemo(
    () => providerCatalogForAvailability(providerCatalog(), providerAvailability),
    [providerAvailability],
  );
  // Platform is a pre-step fork, not a numbered step. Each platform gets its own
  // numbered sequence (Slack: agent → connect → owner; Feishu: agent → connect → permissions),
  // so the two flows no longer share a stepper count.
  const numberedSteps = useMemo<FlowStep[]>(() => {
    const tail: FlowStep[] = workspacePlatform === 'slack' ? ['connect', 'owner'] : ['connect', 'permissions'];
    return ['agent', ...tail];
  }, [workspacePlatform]);
  const onPlatformFork = step === 'platform';
  const currentStepIndex = Math.max(0, numberedSteps.indexOf(step));
  // When Feishu reaches its connected moment, the whole sequence reads done so
  // the success check never sits under an active (red) step dot.
  const feishuAllDone = workspacePlatform === 'feishu' && feishuPhase === 'connected';
  const derivedId = agentIdFromName(name.trim());
  const { pollUntil: pollFeishuRegistrationUntil } = useFeishuRegistrationPoll({
    agentId: createdAgentId ?? derivedId,
  });

  // Display helpers — Base UI SelectValue shows raw value before items register;
  // use render-prop form to always resolve a human label.
  const displayProvider = (v: string) => providerOptions.find((r) => r.kind === v)?.label ?? v;
  const displayModel = (v: string) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : v);
  const displayEffort = (v: string) => (v === 'xhigh' ? 'Extra High' : v ? v.charAt(0).toUpperCase() + v.slice(1) : v);
  const currentProvider = providerOptions.find((o) => o.kind === providerKind);
  const selectedEffortOptions = effortOptionsForSelectedModel(
    currentProvider,
    model,
    providerAvailability,
  );
  const selectedProviderReady = providerReady(currentProvider, providerAvailability);
  const selectedProviderHint = providerUnavailableHint(currentProvider, providerAvailability);
  const selectedProviderAuthority = providerModelAuthorityLabel(currentProvider, providerAvailability);
  const unavailableProviders = unavailableProviderHints(providerOptions, providerAvailability);
  const providerCheckPending = !providerAvailability && !providerAvailabilityError;
  const effectiveCreating = previewCreateLoading || creating;
  const effectiveCreateStage = previewCreateLoading ? 'feishu' : createStage;
  const effectiveFeishuCreateSlow = previewCreateSlow || feishuCreateSlow;

  const homePath = derivedId
    ? defaultAgentHomePath(derivedId, customParent ?? teamAgentsRoot)
    : `${customParent ?? teamAgentsRoot}/<name>`;

  // Auto-select a ready provider when availability resolves.
  useEffect(() => {
    if (!providerAvailability) return;
    if (
      providerReady(
        providerOptions.find((o) => o.kind === providerKind),
        providerAvailability,
      )
    )
      return;
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
      if (e.key !== 'Escape' || effectiveCreating) return;
      if (showPicker) {
        setShowPicker(false);
        return;
      }
      void handleClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose, effectiveCreating, showPicker]);

  useEffect(() => {
    return () => {
      createRunRef.current += 1;
      clearFeishuSlowTimer();
    };
  }, []);

  function handleProviderChange(next: ProviderCatalogEntry['kind']) {
    const nextProvider = providerOptions.find((o) => o.kind === next);
    const nextModel = nextProvider?.defaultModel ?? '';
    const nextEfforts = effortOptionsForSelectedModel(nextProvider, nextModel, providerAvailability);
    setProviderKind(next);
    setModel(nextModel);
    setEffort(
      nextEfforts.includes(DEFAULT_REASONING_EFFORT)
        ? DEFAULT_REASONING_EFFORT
        : (nextEfforts[0] ?? ''),
    );
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

  function clearFeishuSlowTimer() {
    if (feishuSlowTimerRef.current !== null) {
      window.clearTimeout(feishuSlowTimerRef.current);
      feishuSlowTimerRef.current = null;
    }
  }

  function startFeishuSlowTimer(runId: number) {
    clearFeishuSlowTimer();
    setFeishuCreateSlow(false);
    feishuSlowTimerRef.current = window.setTimeout(() => {
      if (createRunRef.current === runId) setFeishuCreateSlow(true);
    }, FEISHU_CREATE_SLOW_MS);
  }

  async function waitForFeishuVerification(
    agentId: string,
    runId: number,
  ): Promise<AgentFeishuRegisterAppStatus | null> {
    const next = await startAgentFeishuAppRegistration(agentId, {
      botName: name.trim() || undefined,
    });
    if (createRunRef.current !== runId) return null;
    setFeishuRegistration(next);

    return pollFeishuRegistrationUntil(next, {
      agentId,
      isCurrentRun: () => createRunRef.current === runId,
      onStatus: setFeishuRegistration,
      shouldContinue: (status) => isFeishuRegistrationActive(status) && !status.verificationUrl,
    });
  }

  async function handleCreate() {
    if (creating) return;
    setNameTouched(true);
    if (!derivedId || !role.trim() || !selectedProviderReady) return;

    const runId = createRunRef.current + 1;
    const preserveFeishuPermissions =
      workspacePlatform === 'feishu' &&
      Boolean(createdAgentId) &&
      (feishuPhase === 'permissions' || feishuPhase === 'connected');
    createRunRef.current = runId;
    setCreating(true);
    setCreateStage(workspacePlatform === 'feishu' && !createdAgentId ? 'feishu' : 'agent');
    setCreateError(null);
    if (!preserveFeishuPermissions) {
      setFeishuRegistration(null);
      setFeishuRegistrationError(undefined);
      setFeishuPhase(undefined);
      setFeishuConnectSource(null);
    }
    if (workspacePlatform === 'feishu' && !preserveFeishuPermissions) startFeishuSlowTimer(runId);
    else clearFeishuSlowTimer();

    let nextAgentId = createdAgentId;
    try {
      // Agent already created (user went back to edit name/role) — update profile and advance.
      if (nextAgentId) {
        await updateAgentProfile(nextAgentId, { displayName: name.trim(), role: role.trim() });
        refreshDashboardData();
      } else {
        const provider = {
          kind: providerKind,
          model,
          ...(selectedEffortOptions.length > 0 && effort ? { reasoningEffort: effort } : {}),
        };
        const agent = await createAgent({
          name: name.trim(),
          role: role.trim(),
          homePath,
          provider,
          teamId,
        });
        nextAgentId = agent.id;
        setCreatedAgentId(agent.id);
      }

      if (createRunRef.current !== runId) return;
      if (workspacePlatform === 'feishu') {
        if (preserveFeishuPermissions) {
          setStep('permissions');
          return;
        }
        try {
          const registration = await waitForFeishuVerification(nextAgentId, runId);
          if (!registration || createRunRef.current !== runId) return;

          if (registration.state === 'connected') {
            setFeishuConnectSource('registerApp');
            setFeishuPhase('permissions');
            setStep('permissions');
            return;
          }

          if (registration.state === 'failed') {
            setFeishuRegistrationError(
              registration.error?.description ?? registration.error?.message ?? 'Could not start Feishu app setup',
            );
            setFeishuPhase('fallback');
            setStep('connect');
            return;
          }

          setFeishuPhase('authorizing');
          setStep('connect');
          return;
        } catch (err) {
          if (createRunRef.current !== runId) return;
          setFeishuRegistrationError(err instanceof Error ? err.message : 'Could not start Feishu app setup');
          setFeishuPhase('fallback');
          setStep('connect');
          return;
        }
      }

      setStep('connect');
    } catch (err) {
      if (createRunRef.current !== runId) return;
      setCreateError(
        err instanceof Error ? err.message : createdAgentId ? 'Failed to update agent' : 'Failed to create agent',
      );
    } finally {
      if (createRunRef.current === runId) {
        clearFeishuSlowTimer();
        setCreating(false);
        setCreateStage(undefined);
        setFeishuCreateSlow(false);
      }
    }
  }

  async function handleSlackConnected() {
    // Await the agents refetch so AgentReconciler sees the new agent before
    // we navigate — otherwise it redirects to a different agent (stale cache).
    await awaitAgentsRefresh();
    setStep('owner');
  }

  async function handleFeishuConnected(source: 'registerApp' | 'manual', agentIdOverride = createdAgentId) {
    setFeishuConnectSource(source);
    await awaitAgentsRefresh();
    // Jump to activity on any successful connect, but only arm the greeting
    // banner when the app was auto-registered — the manual path has no owner
    // open_id and never greets (#154), so a "say hi" promise there would be false.
    if (agentIdOverride) onComplete?.(agentIdOverride, 'feishu', source === 'registerApp');
  }

  function handleFeishuPhaseChange(phase: FeishuOnboardingPhase) {
    setFeishuPhase(phase);
    if (phase === 'permissions') setStep('permissions');
  }

  function handleOwnerComplete() {
    if (createdAgentId) onComplete?.(createdAgentId);
  }

  const stepTitle =
    step === 'platform'
      ? 'Where does your team work?'
      : step === 'agent'
        ? 'Create your agent'
        : step === 'connect'
          ? workspacePlatform === 'feishu'
            ? 'Create Feishu bot'
            : `Connect to ${WORKSPACE_PLATFORM_LABELS[workspacePlatform]}`
          : step === 'permissions'
            ? 'Authorize Feishu permissions'
            : 'Pick an owner';
  const createDisabledReason = (() => {
    if (effectiveCreating) return undefined;
    if (!derivedId) return 'Enter a name';
    if (!role.trim()) return 'Enter a role';
    if (providerAvailabilityError) return 'Provider check failed';
    if (providerCheckPending) return 'Checking providers...';
    if (!selectedProviderReady) return 'Install a provider first';
    return undefined;
  })();
  const createButtonLabel = effectiveCreating
    ? effectiveCreateStage === 'feishu'
      ? 'Creating your Feishu app…'
      : createdAgentId
        ? 'Saving…'
        : 'Creating…'
    : (createDisabledReason ?? (createdAgentId ? 'Save & continue →' : 'Create agent →'));

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
                  onClick={
                    index < currentStepIndex && !(workspacePlatform === 'feishu' && entry === 'connect')
                      ? () => setStep(entry)
                      : undefined
                  }
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
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate();
                }}
                placeholder="e.g. Aria"
                className="w-full rounded-sm border border-border-soft bg-surface px-3 py-2 font-serif text-[15px] text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
              />
              {nameTouched && !derivedId && (
                <p className="font-sans mt-1 text-[11px] text-health-error">
                  Name must include at least one letter or number.
                </p>
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
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate();
                }}
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
                  No providers detected. Install Claude Code, Codex CLI, Kimi CLI, or Grok Build first.
                </p>
              ) : (
                <div
                  className={[
                    'grid gap-2',
                    selectedEffortOptions.length > 0 ? 'grid-cols-3' : 'grid-cols-2',
                  ].join(' ')}
                >
                  <Select
                    value={providerKind}
                    onValueChange={(v) => handleProviderChange(v as ProviderCatalogEntry['kind'])}
                  >
                    <SelectTrigger className="!h-auto w-full py-2 font-serif text-[15px]">
                      <SelectValue>{(v: string) => displayProvider(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {providerOptions.map((r) => {
                        const hint = providerUnavailableHint(r, providerAvailability);
                        return (
                          <SelectItem key={r.kind} value={r.kind} disabled={!!hint}>
                            {r.label}
                            {hint ? ` — ${hint}` : ''}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <Select
                    value={model}
                    onValueChange={(v) => {
                      if (!v) return;
                      const nextEfforts = effortOptionsForSelectedModel(
                        currentProvider,
                        v,
                        providerAvailability,
                      );
                      setModel(v);
                      setEffort(
                        nextEfforts.includes(DEFAULT_REASONING_EFFORT)
                          ? DEFAULT_REASONING_EFFORT
                          : (nextEfforts[0] ?? ''),
                      );
                    }}
                  >
                    <SelectTrigger className="!h-auto w-full py-2 font-serif text-[15px]">
                      <SelectValue>{(v: string) => displayModel(v)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(currentProvider?.models ?? []).map((m) => (
                        <SelectItem key={m} value={m}>
                          {displayModel(m)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedEffortOptions.length > 0 && (
                    <Select
                      value={effort}
                      onValueChange={(v) => {
                        if (v) setEffort(v);
                      }}
                    >
                      <SelectTrigger className="!h-auto w-full py-2 font-serif text-[15px]">
                        <SelectValue>{(v: string) => displayEffort(v)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {selectedEffortOptions.map((e) => (
                          <SelectItem key={e} value={e}>
                            {displayEffort(e)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
              {selectedProviderHint && (
                <p className="font-sans mt-1 text-[11px] text-health-warn">{selectedProviderHint}</p>
              )}
              {selectedProviderAuthority && !selectedProviderHint && (
                <p className="font-sans mt-1 text-[10px] text-text-subtle">{selectedProviderAuthority}</p>
              )}
              {providerCheckPending && (
                <p className="font-sans mt-1 text-[11px] text-text-subtle">Checking installed provider CLIs...</p>
              )}
              {providerAvailabilityError && (
                <p className="font-sans mt-1 text-[11px] text-health-error">
                  Provider check failed:{' '}
                  {providerAvailabilityError instanceof Error
                    ? providerAvailabilityError.message
                    : String(providerAvailabilityError)}
                </p>
              )}
            </div>

            {/* No team picker here: the agent joins whichever team's sidebar the
                "+ add agent" action was launched from (passed in as defaultTeamId).
                Its home lands under that team's folder. */}

            {/* Home — collapsed secondary field; hidden when agent already created (dir exists) */}
            {!createdAgentId && (
              <div>
                <button
                  type="button"
                  onClick={() => setHomeExpanded((v) => !v)}
                  className="font-sans flex items-center gap-1 text-[12px] text-text-muted hover:text-text transition-colors"
                >
                  {homeExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
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
                          Your agent's memory lives here, in its own{' '}
                          <strong className="font-semibold text-text">home folder</strong> under the team's folder.
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
              </div>
            )}
          </div>

          {createError && <p className="font-sans mt-3 text-[12px] text-health-error">{createError}</p>}

          <div className="mt-6">
            <Button
              className="w-full"
              onClick={() => void handleCreate()}
              disabled={effectiveCreating || !!createDisabledReason}
            >
              {effectiveCreating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {createButtonLabel}
            </Button>
            {effectiveCreateStage === 'feishu' && effectiveFeishuCreateSlow && (
              <p className="mt-2 text-center font-sans text-[11px] text-text-subtle">
                This is taking longer than usual.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ---- Step: Connect platform ---- */}
      {step === 'connect' && createdAgentId && workspacePlatform === 'slack' && (
        <div className="px-6 py-6">
          <SlackConnectStepper agentId={createdAgentId} onConnect={handleSlackConnected} />
        </div>
      )}
      {(step === 'connect' || step === 'permissions') && createdAgentId && workspacePlatform === 'feishu' && (
        <div className="px-6 py-6">
          <FeishuOnboardingConnect
            agentId={createdAgentId}
            initialError={feishuRegistrationError}
            initialRegistration={feishuRegistration}
            initialConnectSource={feishuConnectSource ?? undefined}
            previewPhase={previewFeishuPhase}
            onPhaseChange={handleFeishuPhaseChange}
            onPendingConnectSource={setFeishuConnectSource}
            onConnect={(info) => void handleFeishuConnected(info.source)}
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
      onComplete={(id, justConnected, greetingBanner) =>
        navigate(`/agents/${id}/activity`, {
          state: justConnected
            ? { onboardingConnected: justConnected, feishuGreetingBanner: Boolean(greetingBanner) }
            : undefined,
        })
      }
    />
  );
}

// ---------------------------------------------------------------------------
// AgentCreateModal — sidebar "Add agent" entry point
// ---------------------------------------------------------------------------

export function AgentCreateModal({
  onClose,
  teams,
  defaultTeamId,
}: {
  onClose: () => void;
  teams?: TeamConfig[];
  defaultTeamId?: string;
}) {
  const navigate = useNavigate();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm">
      <AgentCreateFlow
        firstRun={false}
        teams={teams}
        defaultTeamId={defaultTeamId}
        onClose={(createdAgentId) => {
          onClose();
          if (createdAgentId) navigate(`/agents/${createdAgentId}/profile`);
        }}
        onComplete={(id, justConnected, greetingBanner) => {
          onClose();
          navigate(`/agents/${id}/activity`, {
            state: justConnected
              ? {
                  onboardingConnected: justConnected,
                  feishuGreetingBanner: Boolean(greetingBanner),
                }
              : undefined,
          });
        }}
      />
    </div>
  );
}
