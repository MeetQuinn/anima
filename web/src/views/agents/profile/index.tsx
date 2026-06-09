import { useEffect, useRef, useState } from 'react';
import { ExternalLink, MessageCircle, RotateCcw, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchAgent,
  fetchAgentSession,
  fetchAgentStatuses,
  refreshAgentData,
  syncAgentAvatar,
  syncAgentFeishuAvatar,
  updateAgentHome,
  updateAgentProfile,
  updateAgentProvider,
} from '@/api/agents';
import { fetchWorkspacePlatform } from '@/api/system';
import { queryKeys } from '@/lib/query-keys';
import { useNow } from '@/hooks/useNow';

import { providerCatalog } from '@shared/provider-catalog';
import { useParams } from 'react-router-dom';
import { formatRelative, shortIso } from '@/lib/format';
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
import { FeishuConnectStepper } from './FeishuConnectStepper';
import { FeishuScopeStatusCard } from './FeishuScopeStatusCard';
import { SlackManifestUpdateCard } from './SlackManifestUpdateCard';
import { SkillsSection } from './SkillsSection';
import { OwnerPickerForm } from './OwnerPickerForm';
import {
  agentFeishuConnected,
  agentHasConnectedTransport,
  agentSlackConnected,
  agentTransportLabel,
} from '@shared/agent-transports';
import type { AgentConfig, ClaudeCodeTransport } from '@shared/agent-config';

type PendingRestart = { kind: string; model: string; effort?: string; transport?: ClaudeCodeTransport };

function FeishuMeta({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0">
      <div className="chrome text-[10px] tracking-[0.1em] text-text-subtle">{label}</div>
      <div className="mt-0.5 break-all font-mono text-[12px] text-text">
        {value || '—'}
      </div>
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
  const { data: agentStatuses = [] } = useQuery({ queryKey: queryKeys.agentStatuses(), queryFn: fetchAgentStatuses });
  const { data: workspacePlatform = 'slack' } = useQuery({
    queryKey: queryKeys.workspacePlatform(),
    queryFn: fetchWorkspacePlatform,
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
  const slackConnected = agentSlackConnected(agent);
  const feishuConnected = agentFeishuConnected(agent);
  const transportConnected = agentHasConnectedTransport(agent);
  const platformLabel = agentTransportLabel(agent);
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
        ...(pendingRestart.transport ? { transport: pendingRestart.transport } : {}),
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
            transport={agent.provider.kind === 'claude-code' ? agent.provider.transport : undefined}
            providerOptions={providerOptions}
            onRequestSave={(kind, model, effort, transport) => setPendingRestart({ kind, model, effort, transport })}
          />
          <ProviderEnvRow
            env={agent.provider.env}
            onCommit={commitProviderEnv}
          />
          <Field label="Platform">
            <ReadonlyValue value={platformLabel} />
          </Field>

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
          {/* Last active — overall last activity (survives session rotation),
              distinct from the current-session "Latest activity" once shown here. */}
          <Field label="Last active">
            {session?.updatedAt ? (
              <span
                className="font-serif text-[15px] text-text"
                title={new Date(session.updatedAt).toLocaleString()}
              >
                {formatRelative(session.updatedAt, now)}
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
                {slackConnected && (
                  <button
                    type="button"
                    onClick={() => setOwnerPickerOpen(true)}
                    className="font-sans ml-1 text-[11px] text-text-subtle underline decoration-text-subtle/40 underline-offset-2 hover:text-text hover:decoration-text/40 transition-colors"
                  >
                    Change
                  </button>
                )}
              </div>
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
                    onConfirm={() => { setOwnerPickerOpen(false); refreshAgentData(agentId); }}
                    submitLabel={agent.owner ? 'Change owner →' : 'Assign owner →'}
                    autoFocus
                    showRationale
                  />
                </div>
              </div>
            </div>
          )}
          {transportConnected && (
            <Field label="Sessions archived">
              <ReadonlyValue value={String(sessionsArchived)} mono />
            </Field>
          )}
        </div>

        {/* ── SLACK ─────────────────────────────────────────────────────────── */}
        {showSlackSetup && (
          <Section title="Slack">
            {slackConnected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 overflow-hidden rounded-sm border border-border-soft bg-surface-elevated px-4 py-3">
                {agent.slack.avatarUrl ? (
                  <img src={agent.slack.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-border-soft" />
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted font-serif text-[17px] font-semibold text-text-muted ring-1 ring-border-soft">
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
        )}

        {/* ── FEISHU ────────────────────────────────────────────────────────── */}
        {showFeishuSetup && (
          <Section title="Feishu">
            {feishuConnected ? (
              <div className="space-y-3">
              <div className="rounded-sm border border-border-soft bg-surface-elevated px-4 py-3">
                <div className="flex items-start gap-3">
                  {agent.feishu.avatarUrl ? (
                    <img src={agent.feishu.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-border-soft" />
                  ) : (
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-border-soft">
                      <MessageCircle className="h-4 w-4" />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-serif text-[15px] font-semibold leading-snug text-text">
                            Feishu
                          </span>
                          <span className="font-sans rounded-sm border border-health-ok/30 bg-health-ok-soft px-1.5 py-0.5 text-[10px] uppercase tracking-[0.08em] text-health-ok">
                            Connected
                          </span>
                        </div>
                        {agent.feishu.avatarUrl && (
                          <div className="font-sans mt-0.5 text-[13px] text-text-muted">Synced from your Feishu app</div>
                        )}
                      </div>
                      <button
                        onClick={() => void handleSyncFeishuAvatar()}
                        disabled={syncingFeishuAvatar}
                        title="Sync avatar from Feishu"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-subtle opacity-40 transition-all hover:bg-page hover:opacity-100 disabled:opacity-20"
                      >
                        <RotateCcw className={`h-3.5 w-3.5 ${syncingFeishuAvatar ? 'animate-spin' : ''}`} />
                      </button>
                    </div>
                    <div className="mt-2 grid gap-2 text-[12px] md:grid-cols-2">
                      <FeishuMeta label="App ID" value={agent.feishu.appId} />
                      <FeishuMeta label="Bot Open ID" value={agent.feishu.botOpenId} />
                      <FeishuMeta label="Credentials" value="Configured" />
                      <FeishuMeta label="Delivery" value="Long-lived connection" />
                    </div>
                  </div>
                </div>
              </div>
              <p className="font-sans text-[12px] leading-relaxed text-text-muted">
                Feishu credentials are stored in the agent config and injected by Anima
                at runtime. Secret values are hidden in the dashboard.
              </p>
              <FeishuScopeStatusCard agentId={agentId} />
              </div>
            ) : (
              <FeishuConnectStepper
                key={agentId}
                agentId={agentId}
                agentName={agent.profile.displayName}
                onConnect={() => refreshAgentData(agentId)}
              />
            )}
          </Section>
        )}

        {/* ── THIS SESSION ──────────────────────────────────────────────────── */}
        {transportConnected && (
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
  if (next.kind !== current.kind) return true;
  return current.kind === 'claude-code'
    && next.transport !== undefined
    && next.transport !== (current.transport ?? 'stream-json');
}
