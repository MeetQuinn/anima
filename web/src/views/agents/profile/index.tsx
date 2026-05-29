import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RotateCcw, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchAgent,
  fetchAgentSession,
  fetchAgentStatuses,
  refreshAgentData,
  syncAgentAvatar,
  updateAgentHome,
  updateAgentProfile,
  updateAgentProvider,
} from '@/api/agents';
import { queryKeys } from '@/lib/query-keys';

import { providerCatalog } from '@shared/provider-catalog';
import { useParams } from 'react-router-dom';
import { shortIso } from '@/lib/format';
import { Field, ReadonlyValue, Section, extractError } from './Primitives';
import {
  InlineTextRow,
  HomeRow,
  ProviderInlineRow,
  ProviderEnvRow,
  ConfirmRestartModal,
} from './AgentFields';
import { SessionSection } from './SessionStats';
import { SlackConnectStepper } from './SlackConnectStepper';
import { SlackManifestUpdateCard } from './SlackManifestUpdateCard';
import { SkillsSection } from './SkillsSection';
import { OwnerPickerForm } from './OwnerPickerForm';

type PendingRestart = { kind: string; model: string; effort?: string };

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
  const { data: agentStatuses = [] } = useQuery({ queryKey: queryKeys.agentStatuses(), queryFn: fetchAgentStatuses });

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

  // Owner picker (reset when agent changes via key prop on OwnerPickerForm).
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);

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
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const providerOptions = providerCatalog();

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
  const isActive = Boolean(
    agentStatuses.find((s) => s.agentId === agentId)?.currentItemId,
  );
  const sessionsArchived = session?.archived?.length ?? 0;
  const createdAt = agent.createdAt ?? session?.createdAt;

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

  async function commitHomePath(next: string) {
    if (!agentId) return;
    await updateAgentHome(agentId, { homePath: next });
    showApplyNoticeIfActive();
    refreshAgentData(agentId);
  }

  async function commitProviderEnv(env: Record<string, string | null>) {
    if (!agentId) return;
    await updateAgentProvider(agentId, { env });
    showApplyNoticeIfActive('Saved. This agent will apply launch env changes when the current item finishes.');
    refreshAgentData(agentId);
  }

  async function handleConfirmRestart() {
    if (!pendingRestart || restartSaving || !agentId) return;
    setRestartSaving(true);
    setRestartSaveError(null);
    try {
      await updateAgentProvider(agentId, {
        kind: pendingRestart.kind,
        model: pendingRestart.model,
        ...(pendingRestart.effort ? { reasoningEffort: pendingRestart.effort } : {}),
      });
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
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-y-auto bg-surface px-6 py-8 md:px-10 md:py-8"
    >
      <div className="max-w-3xl">

        {applyNotice && (
          <div className="relative mb-8 rounded-sm border border-health-warn/30 bg-health-warn-soft px-4 py-3 pl-5">
            <span aria-hidden className="absolute left-0 top-2 bottom-2 w-px bg-health-warn/60" />
            <span className="font-serif text-[14px] text-text">
              {applyNotice}
            </span>
          </div>
        )}

        {/* ── TOP BLOCK ─────────────────────────────────────────────────────── */}
        <div className="divide-y divide-border-soft">
          <InlineTextRow
            label="Name"
            value={agent.profile?.displayName ?? ''}
            placeholder="Unnamed"
            onCommit={(next) => commitProfile({ displayName: next })}
          />
          <InlineTextRow
            label="Role"
            value={agent.profile?.role ?? ''}
            placeholder="No role"
            onCommit={(next) => commitProfile({ role: next })}
          />
          <HomeRow value={agent.homePath ?? ''} onCommit={commitHomePath} />
          <ProviderInlineRow
            kind={agent.provider.kind}
            model={agent.provider.model ?? ''}
            effort={('reasoningEffort' in agent.provider ? agent.provider.reasoningEffort : undefined) ?? ''}
            providerOptions={providerOptions}
            onRequestSave={(kind, model, effort) => setPendingRestart({ kind, model, effort })}
          />
          <ProviderEnvRow
            env={agent.provider.env}
            onCommit={commitProviderEnv}
          />

          {/* Lifetime facts */}
          <Field label="Created">
            {createdAt ? (
              <span
                className="font-serif text-[15px] text-text"
                title={new Date(createdAt).toLocaleString()}
              >
                {shortIso(createdAt)}
              </span>
            ) : (
              <ReadonlyValue />
            )}
          </Field>
          <Field label="Owner">
            {agent.owner ? (
              <div className="flex items-center gap-2">
                {agent.owner.avatarUrl ? (
                  <img src={agent.owner.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted font-sans text-[10px] font-bold text-text-muted">
                    {agent.owner.displayName.charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="font-serif text-[15px] text-text">
                  {agent.owner.displayName}
                  {agent.owner.handle && (
                    <span className="font-sans text-[13px] text-text-muted"> @{agent.owner.handle}</span>
                  )}
                </span>
                {agent.slack?.connected === true && (
                  <button
                    type="button"
                    onClick={() => setOwnerPickerOpen(true)}
                    className="font-sans ml-1 text-[11px] text-text-subtle underline decoration-text-subtle/40 underline-offset-2 hover:text-text hover:decoration-text/40 transition-colors"
                  >
                    Change
                  </button>
                )}
              </div>
            ) : agent.slack?.connected === true ? (
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

          {/* Owner picker modal */}
          {ownerPickerOpen && agent.slack?.connected === true && (
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
                    onConfirm={() => { setOwnerPickerOpen(false); refreshAgentData(agentId); }}
                    submitLabel={agent.owner ? 'Change owner →' : 'Assign owner →'}
                    autoFocus
                    showRationale
                  />
                </div>
              </div>
            </div>
          )}
          {agent.slack?.connected === true && (
            <Field label="Sessions archived">
              <ReadonlyValue value={String(sessionsArchived)} mono />
            </Field>
          )}
        </div>

        {/* ── SLACK ─────────────────────────────────────────────────────────── */}
        <Section title="Slack">
          {agent.slack?.connected === true ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 overflow-hidden rounded-sm border border-border-soft bg-surface-elevated px-4 py-3">
                {agent.slack.avatarUrl ? (
                  <img src={agent.slack.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-sm object-cover" />
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-muted font-serif text-[17px] font-semibold text-text-muted">
                    {(agent.profile?.displayName ?? agent.id).charAt(0).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-serif text-[15px] font-semibold leading-snug text-text">@{agent.id}</div>
                  {agent.slack.workspaceName && (
                    <div className="font-sans mt-0.5 text-[13px] text-text-muted">{agent.slack.workspaceName}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {agent.slack.appId && (
                    <a
                      href={`https://api.slack.com/apps/${agent.slack.appId}/general`}
                      target="_blank"
                      rel="noreferrer"
                      title="Slack App Settings"
                      className="flex h-7 w-7 items-center justify-center rounded-sm text-text-subtle opacity-40 transition-all hover:bg-page hover:opacity-100"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  <button
                    onClick={() => void handleSyncAvatar()}
                    disabled={syncingAvatar}
                    title="Sync avatar from Slack"
                    className="flex h-7 w-7 items-center justify-center rounded-sm text-text-subtle opacity-40 transition-all hover:bg-page hover:opacity-100 disabled:opacity-20"
                  >
                    <RotateCcw className={`h-3.5 w-3.5 ${syncingAvatar ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
              <SlackManifestUpdateCard agentId={agentId} />
            </div>
          ) : (
            <SlackConnectStepper
              agentId={agentId}
              onConnect={() => refreshAgentData(agentId)}
            />
          )}
        </Section>

        {/* ── THIS SESSION ──────────────────────────────────────────────────── */}
        {agent.slack?.connected === true && (
          <Section title="This session">
            <SessionSection stats={stats} session={session ?? undefined} now={now} />
          </Section>
        )}

        {/* ── SKILLS ────────────────────────────────────────────────────────── */}
        <Section title="Skills">
          <SkillsSection agentId={agentId} />
        </Section>
      </div>

      {pendingRestart && (
        <ConfirmRestartModal
          isActive={isActive}
          kindChanged={pendingRestart.kind !== agent.provider.kind}
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
