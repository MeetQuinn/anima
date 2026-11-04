import { useEffect, useRef, useState, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchAgent,
  fetchAgentSession,
  refreshAgentData,
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
import { useParams, useSearchParams } from 'react-router-dom';
import { formatRelative, shortIso } from '@/lib/format';
import { agentAvatarUrl } from '@/lib/agent-avatar';
import { EditAffordance, Field, ReadonlyValue, Section } from './Primitives';
import { HomeRow, TeamRow } from './AgentFields';
import { RuntimeRow } from './RuntimeField';
import { ProfileHero } from './ProfileHero';
import { useTeams, useTeamWarnings } from '@/hooks/useTeams';
import { assignAgentTeam } from '@/api/teams';
import { DEFAULT_TEAM_ID } from '@shared/server-settings';
import { SessionSection } from './SessionStats';
import { SlackConnectStepper } from './SlackConnectStepper';
import { FeishuConnectStepper } from './FeishuConnectStepper';
import { SlackRow } from './SlackRow';
import { FeishuRow } from './FeishuRow';
import { LinearRow } from './LinearRow';
import { SkillsSection } from './SkillsSection';
import { ProfileActionsRail } from './ActionsRail';
import { AgentUsageSection } from '@/components/token-usage/AgentUsageSection';
import { OwnerPickerForm } from './OwnerPickerForm';
import { agentFeishuConnected, agentHasConnectedTransport, agentSlackConnected } from '@shared/agent-transports';
import type { AgentUpdateProviderRequest } from '@shared/agent-config';

export default function Profile() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { agentId } = useParams<{ agentId: string }>();
  const linearReturn = useLinearReturn(agentId);

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

  // Owner picker (reset when agent changes via key prop on OwnerPickerForm).
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);

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

  // One atomic save from the Runtime modal (provider selection, command/args
  // overrides, and env patch travel in a single provider update). Errors are
  // thrown back to the modal, which shows them inline and stays open.
  async function commitRuntime(update: AgentUpdateProviderRequest, opts: { envOnly: boolean }) {
    if (!agentId) return;
    await updateAgentProvider(agentId, update);
    showApplyNoticeIfActive(
      opts.envOnly ? 'Saved. This agent will apply launch env changes when the current item finishes.' : undefined,
    );
    refreshAgentData(agentId);
  }

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-y-auto bg-surface px-6 py-8 md:px-10 md:py-8">
      {/* Two columns at lg: content keeps its measure; the Actions rail
          (task #185) rides the empty right space. Below lg the rail hides and
          the header's ⋯ menu remains the only lifecycle surface. */}
      <div className="flex gap-12">
        <div className="min-w-0 max-w-3xl flex-1">
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
            <RuntimeRow
              provider={agent.provider}
              providerOptions={providerOptions}
              providerAvailability={providerAvailability}
              isActive={isActive}
              onCommit={commitRuntime}
            />
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
          </div>
        </Section>

        {/* ── CONNECTIONS ───────────────────────────────────────────────────── */}
        {/* Where teammates reach this agent. One row per platform, same anatomy;
          details and maintenance open from the row's single action. */}
        <Section title="Connections">
          <div className="divide-y divide-border-soft">
            {slackConnected && (
              <SlackRow
                agentId={agentId}
                agentName={agent.profile.displayName || agentId}
                appId={agent.slack.appId}
                workspaceName={agent.slack.workspaceName}
                workspaceIconUrl={agent.slack.workspaceIconUrl}
              />
            )}
            {feishuConnected && (
              <FeishuRow
                agentId={agentId}
                agentName={agent.profile.displayName || agentId}
                appId={agent.feishu.appId}
                botOpenId={agent.feishu.botOpenId}
              />
            )}
            <LinearRow
              key={agentId}
              agentId={agentId}
              agentName={agent.profile.displayName || agentId}
              avatarUrl={agentAvatarUrl(agent)}
              initialOpen={linearReturn}
            />
          </div>
        </Section>

        {/* Owner picker modal */}
        {ownerPickerOpen && slackConnected && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm">
            <div className="relative mx-4 max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-sm border border-border-soft bg-surface shadow-deep">
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

        <Section title="Token usage">
          <AgentUsageSection agentId={agentId} />
        </Section>

        {/* ── SLACK (connect flow only - the connected state is a row in
            Connections above) ─────────────────────────────────────────────── */}
        {showSlackSetup && !slackConnected && (
          <Section title="Slack">
            <SlackConnectStepper agentId={agentId} onConnect={() => refreshAgentData(agentId)} />
          </Section>
        )}

        {/* ── FEISHU (connect flow only - the connected state is a row in
            Connections above) ─────────────────────────────────────────────── */}
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
        <div className="hidden lg:block">
          <ProfileActionsRail />
        </div>
      </div>
    </div>
  );
}

/**
 * Anima's Linear completion page lands on `?linear=<outcome>`. The param only
 * opens the Linear dialog; what it shows is always read from the server.
 */
function useLinearReturn(agentId: string | undefined): boolean {
  const [params, setParams] = useSearchParams();
  // Remember which agent the return was for, so switching agents doesn't reopen it.
  const [returnedFor] = useState(() => (params.has('linear') ? agentId : undefined));
  useEffect(() => {
    if (!params.has('linear')) return;
    const next = new URLSearchParams(params);
    next.delete('linear');
    setParams(next, { replace: true });
  }, [params, setParams]);
  return returnedFor !== undefined && returnedFor === agentId;
}
