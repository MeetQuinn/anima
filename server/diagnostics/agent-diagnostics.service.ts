import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentConfig } from '../../shared/agent-config.js';
import {
  agentConfiguredPlatformKind,
  agentTransportDisplayLabel,
} from '../../shared/agent-transports.js';
import type { AgentDiagnosticsActivity, AgentDiagnosticsBundle, AgentDiagnosticsLogLine } from '../../shared/diagnostics.js';
import type { Activity } from '../../shared/activity.js';
import type { AgentRuntimeHealthSummary, AgentSessionSummary, AgentStatusSummary } from '../../shared/snapshot.js';
import { defaultAgentRegistryService } from '../agents/agent.service.js';
import { activityServiceForAgent } from '../activities/activity.service.js';
import { resolveAnimaHome } from '../anima-home.js';
import { nowIso } from '../ids.js';
import { defaultRuntimeService } from '../runtime/runtime.service.js';
import { defaultSystemService } from '../services/system.service.js';

const LOG_LINE_CAP = 80;
const ACTIVITY_CAP = 12;
const LOG_TAIL_READ_LIMIT = 240;

export async function buildAgentDiagnostics(agentId: string): Promise<AgentDiagnosticsBundle> {
  const agent = await defaultAgentRegistryService.serviceFor(agentId).getConfig();
  const [serverInfo, statuses, session, recentActivity, logs] = await Promise.all([
    defaultSystemService.serverInfo(),
    defaultRuntimeService.listStatuses(),
    defaultAgentRegistryService.serviceFor(agentId).getSession().catch(() => undefined),
    safeRecentActivity(agentId),
    safeLogTail(agentId),
  ]);
  const status = statuses.find((candidate) => candidate.agentId === agentId)
    ?? await defaultRuntimeService.getStatus(agentId);

  return {
    agent: safeAgent(agent),
    generatedAt: nowIso(),
    logs: {
      cappedAt: LOG_LINE_CAP,
      lines: logs,
    },
    recentActivity,
    recovery: {
      actions: recoveryActions(agent, status),
    },
    redaction: {
      excluded: [
        'environment variables',
        'tokens and secrets',
        'message bodies',
        'raw queue text',
        'raw tool payloads',
      ],
      logPolicy: 'Timestamps plus subsystem/error lines only; payload and message lines are omitted.',
      mode: 'allowlist',
    },
    server: {
      animaHome: redactUserHome(serverInfo.animaHome),
      ...(serverInfo.commit ? { commit: serverInfo.commit } : {}),
      dashboardPort: serverInfo.dashboardPort,
      ...(serverInfo.lastRestart ? { lastServicesRestart: safeLastServicesRestart(serverInfo.lastRestart) } : {}),
      startedAt: serverInfo.startedAt,
      track: serverInfo.track,
      uptimeSeconds: serverInfo.uptimeSeconds,
      version: serverInfo.version,
    },
    ...(session ? { session: safeSession(session) } : {}),
    status: safeStatus(status),
    workspace: workspaceSummary(statuses),
  };
}

function safeAgent(agent: AgentConfig): AgentDiagnosticsBundle['agent'] {
  const platformKind = agentConfiguredPlatformKind(agent);
  return {
    displayName: agent.profile.displayName,
    enabled: agent.enabled !== false,
    homePath: redactUserHome(agent.homePath),
    id: agent.id,
    ...(platformKind
      ? { platform: { kind: platformKind, label: agentTransportDisplayLabel(platformKind) } }
      : {}),
    provider: {
      idleTimeoutMs: agent.provider.idleTimeoutMs,
      kind: agent.provider.kind,
      ...(agent.provider.model ? { model: agent.provider.model } : {}),
      ...('reasoningEffort' in agent.provider && agent.provider.reasoningEffort
        ? { reasoningEffort: agent.provider.reasoningEffort }
        : {}),
    },
    transports: {
      feishu: {
        configured: Boolean(agent.feishu.appId || agent.feishu.avatarUrl || agent.feishu.botOpenId),
        connected: agent.feishu.connected === true,
      },
      slack: {
        configured: Boolean(
          agent.slack.appId
            || agent.slack.teamId
            || agent.slack.workspaceName
            || agent.slack.workspaceIconUrl
            || agent.slack.avatarUrl
        ),
        connected: agent.slack.connected === true,
      },
    },
  };
}

function safeSession(session: AgentSessionSummary): AgentDiagnosticsBundle['session'] {
  return {
    archivedCount: session.archived?.length ?? 0,
    createdAt: session.createdAt,
    ...(session.current ? { current: session.current } : {}),
    ...(session.currentStartedAt ? { currentStartedAt: session.currentStartedAt } : {}),
    ...(session.latestProviderStats ? { latestProviderStats: session.latestProviderStats } : {}),
    ...(session.lifetimeTokens !== undefined ? { lifetimeTokens: session.lifetimeTokens } : {}),
    updatedAt: session.updatedAt,
  };
}

function safeLastServicesRestart(
  lastRestart: NonNullable<Awaited<ReturnType<typeof defaultSystemService.serverInfo>>['lastRestart']>,
): NonNullable<AgentDiagnosticsBundle['server']['lastServicesRestart']> {
  if (lastRestart.status === 'blocked') {
    return {
      blockerCount: lastRestart.blockers.length,
      completedAt: lastRestart.completedAt,
      reason: lastRestart.reason,
      status: lastRestart.status,
    };
  }
  return {
    completedAt: lastRestart.completedAt,
    mode: lastRestart.mode,
    requestedCount: lastRestart.requestedCount,
    resumedCount: lastRestart.resumedCount,
    status: lastRestart.status,
  };
}

function workspaceSummary(statuses: AgentStatusSummary[]): AgentDiagnosticsBundle['workspace'] {
  const health = {
    degraded: 0,
    healthy: 0,
    notExpected: 0,
    starting: 0,
    unhealthy: 0,
    unknown: 0,
  };
  let runningCount = 0;
  for (const status of statuses) {
    if (status.currentItemId) runningCount += 1;
    if (!status.health) {
      health.notExpected += 1;
      continue;
    }
    health[status.health.state] += 1;
  }
  return {
    agentCount: statuses.length,
    health,
    runningCount,
  };
}

function safeStatus(status: AgentStatusSummary): AgentStatusSummary {
  return {
    agentId: status.agentId,
    ...(status.currentItemId ? { currentItemId: status.currentItemId } : {}),
    ...(status.currentItemStartedAt ? { currentItemStartedAt: status.currentItemStartedAt } : {}),
    ...(status.health ? { health: safeHealth(status.health) } : {}),
    itemCount: status.itemCount,
    queueDepth: status.queueDepth,
  };
}

function safeHealth(health: AgentRuntimeHealthSummary): AgentRuntimeHealthSummary {
  const runtime = health.runtime;
  return {
    ...(health.reason ? { reason: health.reason } : {}),
    ...(health.restart ? { restart: health.restart } : {}),
    ...(runtime
      ? {
          runtime: {
            ...(runtime.activeItemId ? { activeItemId: runtime.activeItemId } : {}),
            ...(runtime.activeItemStartedAt ? { activeItemStartedAt: runtime.activeItemStartedAt } : {}),
            ...(runtime.processId ? { processId: runtime.processId } : {}),
            ...(runtime.providerChild
              ? {
                  providerChild: {
                    alive: runtime.providerChild.alive,
                    command: runtime.providerChild.label,
                    exited: runtime.providerChild.exited,
                    ...(runtime.providerChild.exitedAt ? { exitedAt: runtime.providerChild.exitedAt } : {}),
                    ...(runtime.providerChild.exitCode !== undefined ? { exitCode: runtime.providerChild.exitCode } : {}),
                    label: runtime.providerChild.label,
                    ...(runtime.providerChild.lastStderrAt ? { lastStderrAt: runtime.providerChild.lastStderrAt } : {}),
                    ...(runtime.providerChild.lastStdoutAt ? { lastStdoutAt: runtime.providerChild.lastStdoutAt } : {}),
                    ...(runtime.providerChild.pid ? { pid: runtime.providerChild.pid } : {}),
                    ...(runtime.providerChild.signal !== undefined ? { signal: runtime.providerChild.signal } : {}),
                    startedAt: runtime.providerChild.startedAt,
                    stdinWritable: runtime.providerChild.stdinWritable,
                  },
                }
              : {}),
            providerChildExpected: runtime.providerChildExpected,
            ...(runtime.workerId ? { workerId: runtime.workerId } : {}),
          },
        }
      : {}),
    state: health.state,
    updatedAt: health.updatedAt,
  };
}

function recoveryActions(agent: AgentConfig, status: AgentStatusSummary): AgentDiagnosticsBundle['recovery']['actions'] {
  const enabled = agent.enabled !== false;
  const running = Boolean(status.currentItemId);
  const providerReason = status.health?.reason;
  const providerFailure = providerReason === 'provider_auth_failed'
    || providerReason === 'provider_quota_exhausted'
    || providerReason === 'provider_rate_limited';
  return [
    {
      available: running,
      id: 'stop',
      label: 'Stop',
    },
    enabled
      ? {
          available: !running,
          ...(running ? { blockedReason: 'Agent is running. Stop the agent before disabling.' } : {}),
          id: 'disable',
          label: 'Disable',
        }
      : {
          available: true,
          id: 'enable',
          label: 'Enable',
        },
    providerReason === 'provider_auth_failed'
      ? {
          available: true,
          id: 'check_provider_settings',
          label: 'Check provider settings',
        }
      : {
          available: enabled && !providerFailure,
          ...(enabled
            ? providerFailure
              ? { blockedReason: 'Provider action required.' }
              : {}
            : { blockedReason: 'Agent is disabled. Enable it to run.' }),
          id: 'restart_agent',
          label: 'Restart agent',
        },
    {
      available: true,
      id: 'copy_diagnostics',
      label: 'Copy diagnostics',
    },
  ];
}

async function safeRecentActivity(agentId: string): Promise<AgentDiagnosticsActivity[]> {
  const activities = await activityServiceForAgent(agentId).readLastN(ACTIVITY_CAP).catch(() => []);
  return activities.map(safeActivity);
}

function safeActivity(activity: Activity): AgentDiagnosticsActivity {
  const payload = activity.payload ?? {};
  return {
    activityId: activity.activityId,
    createdAt: activity.createdAt,
    ...copyString(payload, 'activeItemId'),
    ...copyNumber(payload, 'archivedCount'),
    ...copyTokenString(payload, 'eventType'),
    ...copyTokenString(payload, 'failureSource'),
    ...copyNumber(payload, 'maxRetries'),
    ...copyTokenString(payload, 'providerReason'),
    ...copyTokenString(payload, 'reason'),
    ...copyBoolean(payload, 'retryable'),
    ...copyNumber(payload, 'retryAttempts'),
    ...copyTokenString(payload, 'runtimeKind'),
    ...copyTokenString(payload, 'status'),
    ...copyNumber(payload, 'timeoutMs'),
    type: activity.type,
  };
}

async function safeLogTail(agentId: string): Promise<AgentDiagnosticsLogLine[]> {
  const logsDir = join(resolveAnimaHome(), 'logs');
  const sourceFiles = [
    'agent.log',
    'web.log',
    'services-restart.log',
    'runtime-upgrade.log',
  ] as const;
  const linesBySource = await Promise.all(sourceFiles.map(async (source) => {
    const lines = await tailLines(join(logsDir, source), LOG_TAIL_READ_LIMIT);
    return lines.flatMap((line) => safeLogLine(source, agentId, line));
  }));
  return linesBySource
    .flat()
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-LOG_LINE_CAP);
}

async function tailLines(path: string, limit: number): Promise<string[]> {
  const content = await readFile(path, 'utf8').catch(() => '');
  if (!content) return [];
  return content.split(/\r?\n/).filter(Boolean).slice(-limit);
}

function safeLogLine(
  source: AgentDiagnosticsLogLine['source'],
  agentId: string,
  line: string,
): AgentDiagnosticsLogLine[] {
  if (!logLineLooksRelevant(line, agentId)) return [];
  if (logLineLooksUnsafe(line)) return [];
  const timestamp = logTimestamp(line);
  if (!timestamp) return [];
  const scrubbed = scrubLogLine(line).trim();
  if (!scrubbed) return [];
  return [{
    message: truncate(scrubbed, 280),
    source,
    timestamp,
  }];
}

function logLineLooksRelevant(line: string, agentId: string): boolean {
  const escapedAgentId = escapeRegExp(agentId);
  const agentPattern = new RegExp(`\\bAgent\\s+${escapedAgentId}\\b|\\b${escapedAgentId}\\b`, 'i');
  return agentPattern.test(line)
    || /\b(error|failed|failure|health|provider|quota|rate|restart|stale|unhealthy)\b/i.test(line);
}

function logLineLooksUnsafe(line: string): boolean {
  return /\b(payload|blocks|attachments|body|raw queue|rawQueue|message body|prompt|content)\b\s*[:=]/i.test(line)
    || /"text"\s*:/i.test(line)
    || /\btext\s*[:=]/i.test(line)
    || /\b(SLACK|FEISHU|ANTHROPIC|OPENAI|CODEX|KIMI)_[A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD)\b/i.test(line);
}

function logTimestamp(line: string): string | undefined {
  const match = line.match(/\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\]?/);
  return match?.[1];
}

function scrubLogLine(line: string): string {
  return line
    .replace(/xox[a-z]?-[A-Za-z0-9-]+/g, '<redacted-token>')
    .replace(/xapp-[A-Za-z0-9-]+/g, '<redacted-token>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted-token>')
    .replace(/([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)[A-Za-z0-9_]*)=\S+/gi, '$1=<redacted>');
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function copyString(payload: Record<string, unknown>, key: string): Record<string, string> {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? { [key]: value } : {};
}

function copyTokenString(payload: Record<string, unknown>, key: string): Record<string, string> {
  const value = payload[key];
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(trimmed) ? { [key]: trimmed } : {};
}

function copyNumber(payload: Record<string, unknown>, key: string): Record<string, number> {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {};
}

function copyBoolean(payload: Record<string, unknown>, key: string): Record<string, boolean> {
  const value = payload[key];
  return typeof value === 'boolean' ? { [key]: value } : {};
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactUserHome(path: string): string {
  const home = homedir();
  if (!home) return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}
