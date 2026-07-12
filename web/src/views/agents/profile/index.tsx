import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ChevronDown, ExternalLink, RotateCcw, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchAgent,
  fetchAgentSession,
  refreshAgentData,
  syncAgentAvatar,
  syncAgentFeishuAvatar,
  updateAgentHome,
  updateAgentProfile,
  updateAgentProvider,
} from '@/api/agents';
import { fetchProviderAvailability, fetchWorkspacePlatform } from '@/api/system';
import { queryClient } from '@/query-client';
import { queryKeys } from '@/lib/query-keys';
import { useAgentStatuses } from '@/hooks/useAgentDirectory';
import { useNow } from '@/hooks/useNow';
import { providerCatalogForAvailability } from '@/lib/provider-availability';

import { providerCatalog } from '@shared/provider-catalog';
import { useParams } from 'react-router-dom';
import { formatRelative, shortIso } from '@/lib/format';
import { EditAffordance, Field, ReadonlyValue, Section, extractError } from './Primitives';
import { HomeRow, TeamRow, ProviderInlineRow, ProviderEnvRow, ConfirmRestartModal } from './AgentFields';
import { ProfileHero } from './ProfileHero';
import { useTeams, useTeamWarnings } from '@/hooks/useTeams';
import { assignAgentTeam } from '@/api/teams';
import { DEFAULT_TEAM_ID } from '@shared/server-settings';
import { SessionSection } from './SessionStats';
import { SlackConnectStepper } from './SlackConnectStepper';
import { FeishuConnectStepper } from './FeishuConnectStepper';
import { FeishuScopeStatusCard } from './FeishuScopeStatusCard';
import { SlackManifestUpdateCard } from './SlackManifestUpdateCard';
import { SkillsSection } from './SkillsSection';
import { OwnerPickerForm } from './OwnerPickerForm';
import { agentFeishuConnected, agentHasConnectedTransport, agentSlackConnected } from '@shared/agent-transports';
import type { AgentConfig, AgentUpdateProviderRequest } from '@shared/agent-config';

type PendingRestart = {
  kind: string;
  model: string;
  effort?: string;
};

function FeishuMeta({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0">
      <div className="chrome text-[10px] tracking-[0.1em] text-text-subtle">{label}</div>
      <div className="mt-0.5 break-all font-mono text-[12px] text-text">{value || '—'}</div>
    </div>
  );
}

export default function Profile() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { agentId } = useParams<{ agentId: string }>();

  useEffect(() => {
    containerRef.current?.scrollTo(0, 0);
  }, [agentId]);

  const { data: agent, isError: agentNotFound } = useQuery({
    queryKey: queryKeys.agent(agentId ?? ''),
    queryFn: () => fetchAgent(agentId!),
    enabled: !!agentId,
    retry: false,
  });
  const { data: agentStatuses = [] } = useAgentStatuses();
  const { data: workspacePlatform = 'slack' } = useQuery({
    queryKey: queryKeys.workspacePlatform(),
    queryFn: fetchWorkspacePlatform,
  });
  const teams = useTeams();
  // Repairable team-reference warning for THIS agent (its teamId names a team
  // that no longer exists). Surfaced here, next to the Team field, rather than
  // in the sidebar — it belongs on the agent it concerns.
  const teamWarning = useTeamWarnings().find((w) => w.agentId === agentId);
  const { data: providerAvailability = null } = useQuery({
    queryKey: queryKeys.providerAvailability(),
    queryFn: fetchProviderAvailability,
  });

  const currentItemId = agentStatuses.find((s) => s.agentId === agentId)?.currentItemId;

  // Session stats — fetched independently so /api/agents stays lightweight.
  // currentItemId is in the query key so stats refresh when a turn completes.
  const { data: session } = useQuery({
    queryKey: queryKeys.agentSession(agentId ?? '', currentItemId),
    queryFn: () => fetchAgentSession(agentId!),
    enabled: !!agentId,
  });

  // Avatar sync.
  const [syncingAvatar, setSyncingAvatar] = useState(false);
  const [syncingFeishuAvatar, setSyncingFeishuAvatar] = useState(false);

  // Owner picker (reset when agent changes via key prop on OwnerPickerForm).
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);

  // Feishu ledger-row details expand (App/Bot IDs, credentials note).
  const [feishuDetailsOpen, setFeishuDetailsOpen] = useState(false);

  // Provider-bound changes are applied by the agent host without bouncing other agents.
  const [pendingRestart, setPendingRestart] = useState<PendingRestart | null>(null);
  const [restartSaving, setRestartSaving] = useState(false);
  const [restartSaveError, setRestartSaveError] = useState<string | null>(null);

  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  function flashApplyNotice(message = 'Saved. This agent will apply the change when the current item finishes.') {
    setApplyNotice(message);
    setTimeout(() => setApplyNotice(null), 6000);
  }

  function showApplyNoticeIfActive(message?: string) {
    if (isActive) flashApplyNotice(message);
  }

  // Must be declared before any early returns — hooks must run in the same
  // order every render regardless of conditional branches.
  const now = useNow();

  const providerOptions = providerCatalogForAvailability(providerCatalog(), providerAvailability);

  if (!agentId) return null;
  if (agentNotFound) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-surface">
        <span className="font-serif text-[14px] text-text-muted">Agent not found.</span>
      </div>
    );
  }
  if (!agent) {
    // Data still loading.
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-surface">
        <div className="h-6 w-28 animate-pulse rounded bg-surface-elevated" />
      </div>
    );
  }
  if (!agent.provider) return null;

  const stats = session?.latestProviderStats;
  const isActive = Boolean(agentStatuses.find((s) => s.agentId === agentId)?.currentItemId);
  const sessionsArchived = session?.archived?.length ?? 0;
  const createdAt = agent.createdAt ?? session?.createdAt;
  const slackConnected = agentSlackConnected(agent);
  const feishuConnected = agentFeishuConnected(agent);
  const transportConnected = agentHasConnectedTransport(agent);
  const showFeishuSetup = feishuConnected || (!transportConnected && workspacePlatform === 'feishu');
  const showSlackSetup = !feishuConnected && (slackConnected || (!transportConnected && workspacePlatform === 'slack'));

  // Per-row commit: sends only the changed fields to the owning profile/provider API.
  async function commitProfile(
    patch: Partial<{
      displayName: string;
      model: string;
      kind: string;
      reasoningEffort?: string;
      role: string;
    }>,
  ) {
    if (!agentId) return;
    const profile: { displayName?: string; role?: string } = {};
    const provider: { kind?: string; model?: string; reasoningEffort?: string } = {};
    if ('displayName' in patch || 'role' in patch) {
      if ('displayName' in patch) profile.displayName = patch.displayName;
      if ('role' in patch) profile.role = patch.role;
    }
    if ('kind' in patch || 'model' in patch || 'reasoningEffort' in patch) {
      if ('kind' in patch) provider.kind = patch.kind;
      if ('model' in patch) provider.model = patch.model;
      if ('reasoningEffort' in patch) provider.reasoningEffort = patch.reasoningEffort;
    }
    if (Object.keys(profile).length > 0 || Object.keys(provider).length > 0) {
      if (Object.keys(profile).length > 0) await updateAgentProfile(agentId, profile);
      if (Object.keys(provider).length > 0) await updateAgentProvider(agentId, provider);
      showApplyNoticeIfActive();
      refreshAgentData(agentId);
    }
  }

  async function handleSyncAvatar() {
    if (!agentId || syncingAvatar) return;
    setSyncingAvatar(true);
    try {
      await syncAgentAvatar(agentId);
      refreshAgentData(agentId);
    } catch {
      // silent — avatar sync is best-effort
    } finally {
      setSyncingAvatar(false);
    }
  }

  async function handleSyncFeishuAvatar() {
    if (!agentId || syncingFeishuAvatar) return;
    setSyncingFeishuAvatar(true);
    try {
      await syncAgentFeishuAvatar(agentId);
      refreshAgentData(agentId);
    } catch {
      // silent — avatar sync is best-effort
    } finally {
      setSyncingFeishuAvatar(false);
    }
  }

  async function commitHomePath(next: string) {
    if (!agentId) return;
    await updateAgentHome(agentId, { homePath: next });
    showApplyNoticeIfActive();
    refreshAgentData(agentId);
  }

  async function commitTeam(nextTeamId: string) {
    if (!agentId) return;
    // Label-only: home is untouched, so no idle-apply notice is needed.
    await assignAgentTeam(agentId, nextTeamId);
    refreshAgentData(agentId);
    // The dangling-team warning shown below this field derives from the teams
    // query, which refreshAgentData does not touch. Invalidate it so following
    // the warning's own instruction ("reassign it above to repair") clears the
    // warning immediately, instead of leaving a false one at the action site
    // until an unrelated teams refetch (window focus, etc.).
    queryClient.invalidateQueries({ queryKey: queryKeys.teams() });
  }

  async function commitProviderEnv(env: Record<string, string | null>) {
    if (!agentId) return;
    await updateAgentProvider(agentId, { env });
    showApplyNoticeIfActive('Saved. This agent will apply launch env changes when the current item finishes.');
    refreshAgentData(agentId);
  }

  async function handleConfirmRestart() {
    if (!pendingRestart || restartSaving || !agentId || !agent) return;
    setRestartSaving(true);
    setRestartSaveError(null);
    try {
      await updateAgentProvider(agentId, providerUpdateForRestart(pendingRestart));
      setPendingRestart(null);
      showApplyNoticeIfActive();
      refreshAgentData(agentId);
    } catch (e) {
      setRestartSaveError(extractError(e));
      setPendingRestart(null);
    } finally {
      setRestartSaving(false);
    }
  }

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-y-auto bg-surface px-6 py-8 md:px-10 md:py-8">
      <div className="max-w-3xl">
        {applyNotice && (
          <div className="relative mb-8 rounded-sm border border-health-warn/30 bg-health-warn-soft px-4 py-3 pl-5">
            <span aria-hidden className="absolute left-0 top-2 bottom-2 w-px bg-health-warn/60" />
            <span className="font-serif text-[14px] text-text">{applyNotice}</span>
          </div>
        )}

        {/* ── IDENTITY ──────────────────────────────────────────────────────── */}
        {/* Large avatar + editable name/role + the lifecycle line. The meta
            facts (read-only, rarely acted on) ride inside the hero as one
            muted line instead of three ledger rows - hover the dates for
            full timestamps. */}
        <ProfileHero
          agent={agent}
          onCommitName={(next) => commitProfile({ displayName: next })}
          onCommitRole={(next) => commitProfile({ role: next })}
        >
          <div className="flex flex-col gap-y-1 font-sans text-[12px] tracking-wide text-text-subtle md:flex-row md:flex-wrap md:items-center md:gap-x-2">
            {[
              createdAt ? (
                <span key="created" title={new Date(createdAt).toLocaleString()}>
                  Created {shortIso(createdAt)}
                </span>
              ) : null,
              session?.updatedAt ? (
                <span key="active" title={new Date(session.updatedAt).toLocaleString()}>
                  Last active {formatRelative(session.updatedAt, now)}
                </span>
              ) : null,
              transportConnected ? (
                <span key="archived">
                  {sessionsArchived} session{sessionsArchived === 1 ? '' : 's'} archived
                </span>
              ) : null,
            ]
              .filter((node): node is ReactElement => node !== null)
              .map((node, i) => (
                <span key={node.key} className="flex items-center gap-x-2">
                  {/* Dot separators only when the facts run inline; stacked on
                    small screens a leading dot reads as a stray bullet. */}
                  {i > 0 && (
                    <span aria-hidden className="hidden md:inline">
                      ·
                    </span>
                  )}
                  {node}
                </span>
              ))}
          </div>
        </ProfileHero>

        {/* ── SETUP ─────────────────────────────────────────────────────────── */}
        <Section title="Setup">
          <div className="divide-y divide-border-soft">
            <HomeRow value={agent.homePath ?? ''} onCommit={commitHomePath} />
            <TeamRow teams={teams} value={agent.teamId ?? DEFAULT_TEAM_ID} onCommit={commitTeam} />
            {teamWarning && (
              <div className="relative py-3 pl-5" role="status">
                <span aria-hidden className="absolute left-0 top-3 bottom-3 w-px bg-health-warn/60" />
                <span className="font-serif text-[13px] leading-snug text-text-muted">
                  This agent references team <span className="font-mono text-text">"{teamWarning.teamId}"</span>, which
                  no longer exists. It is running under the default team - reassign it above to repair.
                </span>
              </div>
            )}
            <ProviderInlineRow
              kind={agent.provider.kind}
              model={agent.provider.model ?? ''}
              effort={('reasoningEffort' in agent.provider ? agent.provider.reasoningEffort : undefined) ?? ''}
              providerOptions={providerOptions}
              providerAvailability={providerAvailability}
              onRequestSave={(kind, model, effort) => setPendingRestart({ kind, model, effort })}
            />
            <ProviderEnvRow env={agent.provider.env} onCommit={commitProviderEnv} />
            <Field label="Owner">
              {agent.owner ? (
                (() => {
                  // Two-line identity cell: avatar spans name (line 1) + @handle (line 2).
                  // Reveals the edit affordance on hover like the other rows (Change link
                  // dropped) — click opens the owner picker.
                  const owner = agent.owner;
                  const cell = (
                    <span className="flex items-center gap-2.5">
                      {owner.avatarUrl ? (
                        <img src={owner.avatarUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted font-sans text-[12px] font-bold text-text-muted">
                          {owner.displayName.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="font-serif text-[15px] text-text">{owner.displayName}</span>
                        {owner.handle && <span className="font-sans text-[13px] text-text-muted">@{owner.handle}</span>}
                      </span>
                    </span>
                  );
                  return slackConnected ? (
                    <EditAffordance onEdit={() => setOwnerPickerOpen(true)}>{cell}</EditAffordance>
                  ) : (
                    cell
                  );
                })()
              ) : slackConnected ? (
                <button
                  type="button"
                  onClick={() => setOwnerPickerOpen(true)}
                  className="font-sans text-[13px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent transition-colors"
                >
                  Assign owner →
                </button>
              ) : (
                <ReadonlyValue />
              )}
            </Field>

            {/* Slack connection as a ledger row, same language as the rest of
              Setup - a connection is configuration, not a person, so it gets
              no card and no face. The connect stepper (below) still gets its
              own section when nothing is connected yet. */}
            {slackConnected && (
              <Field label="Slack">
                <div className="flex min-w-0 items-center gap-3">
                  {/* No "Connected" chip - a row in the Setup ledger only exists
                    when the connection does; the label would restate the row.
                    Baseline-aligned: the handle and workspace run at different
                    sizes, so centering the boxes made them look off-kilter. */}
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-serif text-[15px] text-text">@{agent.id}</span>
                    {agent.slack.workspaceName && (
                      <>
                        <span aria-hidden className="font-sans text-[13px] text-text-subtle">
                          ·
                        </span>
                        <span className="font-sans text-[13px] text-text-muted">{agent.slack.workspaceName}</span>
                      </>
                    )}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    {agent.slack.appId && (
                      <a
                        href={`https://api.slack.com/apps/${agent.slack.appId}/general`}
                        target="_blank"
                        rel="noreferrer"
                        title="Slack App Settings"
                        className="flex h-7 w-7 items-center justify-center rounded-sm text-text-subtle opacity-40 transition-all hover:bg-surface-elevated hover:opacity-100"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                    <button
                      onClick={() => void handleSyncAvatar()}
                      disabled={syncingAvatar}
                      title="Sync avatar from Slack"
                      className="flex h-7 w-7 items-center justify-center rounded-sm text-text-subtle opacity-40 transition-all hover:bg-surface-elevated hover:opacity-100 disabled:opacity-20"
                    >
                      <RotateCcw className={`h-3.5 w-3.5 ${syncingAvatar ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </div>
              </Field>
            )}

            {/* Feishu connection, same ledger-row language as Slack. The App/Bot
              IDs and credentials note fold behind a Details toggle - present
              when needed, silent otherwise. */}
            {feishuConnected && (
              <Field label="Feishu">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="break-all font-mono text-[13px] text-text">{agent.feishu.appId || '—'}</span>
                    <button
                      type="button"
                      onClick={() => setFeishuDetailsOpen((open) => !open)}
                      aria-expanded={feishuDetailsOpen}
                      className="inline-flex items-center gap-1 font-sans text-[11px] text-text-subtle underline decoration-text-subtle/40 underline-offset-2 hover:text-text-muted hover:decoration-text-muted/40"
                    >
                      <ChevronDown
                        className={`h-3 w-3 transition-transform ${feishuDetailsOpen ? 'rotate-180' : ''}`}
                      />
                      {feishuDetailsOpen ? 'Hide details' : 'Details'}
                    </button>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    <button
                      onClick={() => void handleSyncFeishuAvatar()}
                      disabled={syncingFeishuAvatar}
                      title="Sync avatar from Feishu"
                      className="flex h-7 w-7 items-center justify-center rounded-sm text-text-subtle opacity-40 transition-all hover:bg-surface-elevated hover:opacity-100 disabled:opacity-20"
                    >
                      <RotateCcw className={`h-3.5 w-3.5 ${syncingFeishuAvatar ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </div>
                {feishuDetailsOpen && (
                  <div className="mt-3 space-y-3">
                    <div className="grid gap-2 md:grid-cols-2">
                      <FeishuMeta label="Bot Open ID" value={agent.feishu.botOpenId} />
                      <FeishuMeta label="Credentials" value="Configured" />
                      <FeishuMeta label="Delivery" value="Long-lived connection" />
                    </div>
                    <p className="font-sans text-[12px] leading-relaxed text-text-muted">
                      Feishu credentials are stored in the agent config and injected by Anima at runtime. Secret values
                      are hidden in the dashboard.
                    </p>
                  </div>
                )}
              </Field>
            )}
          </div>
          {slackConnected && (
            <div className="mt-4">
              <SlackManifestUpdateCard agentId={agentId} />
            </div>
          )}
          {feishuConnected && (
            <div className="mt-4">
              <FeishuScopeStatusCard agentId={agentId} />
            </div>
          )}
        </Section>

        {/* Owner picker modal */}
        {ownerPickerOpen && slackConnected && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm">
            <div className="relative w-full max-w-md rounded-sm border border-border-soft bg-surface shadow-deep">
              <div className="flex items-center justify-between border-b border-border-soft px-5 py-4">
                <span className="font-serif text-[15px] font-semibold text-text">
                  {agent.owner ? 'Change owner' : 'Assign owner'}
                </span>
                <button
                  onClick={() => setOwnerPickerOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-sm text-text-muted hover:bg-surface-elevated hover:text-text"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-5">
                <OwnerPickerForm
                  key={agentId}
                  agentId={agentId}
                  onConfirm={() => {
                    setOwnerPickerOpen(false);
                    refreshAgentData(agentId);
                  }}
                  submitLabel={agent.owner ? 'Change owner →' : 'Assign owner →'}
                  autoFocus
                  showRationale
                />
              </div>
            </div>
          </div>
        )}

        {/* ── THIS SESSION ──────────────────────────────────────────────────── */}
        {/* Vitals sit right under Setup: the most-glanced facts on the page
            shouldn't hide below the transport plumbing. */}
        {transportConnected && (
          <Section title="This session">
            <SessionSection stats={stats} session={session ?? undefined} now={now} />
          </Section>
        )}

        {/* ── SLACK (connect flow only - the connected state lives as a Setup
            row above) ─────────────────────────────────────────────────────── */}
        {showSlackSetup && !slackConnected && (
          <Section title="Slack">
            <SlackConnectStepper agentId={agentId} onConnect={() => refreshAgentData(agentId)} />
          </Section>
        )}

        {/* ── FEISHU (connect flow only - the connected state lives as a Setup
            row above) ─────────────────────────────────────────────────────── */}
        {showFeishuSetup && !feishuConnected && (
          <Section title="Feishu">
            <FeishuConnectStepper
              key={agentId}
              agentId={agentId}
              agentName={agent.profile.displayName}
              onConnect={() => refreshAgentData(agentId)}
            />
          </Section>
        )}

        {/* ── SKILLS ────────────────────────────────────────────────────────── */}
        <Section title="Skills">
          <SkillsSection agentId={agentId} homePath={agent.homePath ?? ''} />
        </Section>
      </div>

      {pendingRestart && (
        <ConfirmRestartModal
          isActive={isActive}
          sessionBoundaryChanged={providerSessionBoundaryWillChange(agent.provider, pendingRestart)}
          saving={restartSaving}
          onConfirm={() => void handleConfirmRestart()}
          onCancel={() => setPendingRestart(null)}
        />
      )}

      {restartSaveError && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-sm border border-health-error/40 bg-health-error-soft px-4 py-2 shadow-deep">
          <span className="font-sans text-[12px] text-health-error">{restartSaveError}</span>
          <button
            className="ml-3 font-sans text-[11px] text-text-muted hover:text-text"
            onClick={() => setRestartSaveError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function providerSessionBoundaryWillChange(
  current: NonNullable<AgentConfig['provider']>,
  next: PendingRestart,
): boolean {
  return next.kind !== current.kind;
}

function providerUpdateForRestart(next: PendingRestart): AgentUpdateProviderRequest {
  const update: AgentUpdateProviderRequest = {
    kind: next.kind,
    model: next.model,
    ...(next.effort ? { reasoningEffort: next.effort } : {}),
  };
  return update;
}
