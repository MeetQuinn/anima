import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAnimaHome } from '../anima-home.js';
import type { RuntimeItemContext } from './types.js';
import { reminderServiceForAgent } from '../reminders/reminder.service.js';
import {
  recordAgentText,
  recordRuntimeActivity,
  recordRuntimeEvent,
  recordRuntimeOutputChunk,
  recordRuntimeToolFailed,
  recordRuntimeToolStarted,
  type RuntimeActivityTarget,
} from './activity.js';
import { buildCodeAgentDeliveryPrompt, type CodeAgentPromptContext } from './delivery-prompt.js';
import { defaultServerSettingsService } from '../settings/settings.service.js';
import {
  runtimeSessionServiceForAgent,
  type ProviderSession,
  type Session,
} from './runtime-session.service.js';
import { buildAnimaRuntimeProfile, type AnimaRuntimeProfile } from './standing-prompt.js';
import type {
  AgentRuntime,
  AgentRuntimeEffects,
  AgentRuntimeFollowupInput,
  AgentRuntimeInput,
  ProviderSessionRecord,
} from '../providers/contract.js';
import { agentTokenUsageServiceForAgent } from '../usage/agent-token-usage.service.js';
import { ANIMA_MEMORY_COHERENCE_SEAL_ENV } from './memory-coherence-seal.js';

export class AgentRuntimeBridge {
  constructor(private readonly runtime: AgentRuntime) {}

  async runInput(input: {
    context: RuntimeItemContext;
    onActivity?: () => void;
    onProviderProgress?: () => void;
    /** Cut (b): commit cursor delivery once at runtime.started, then release follow-ups. */
    onRuntimeStarted?: () => Promise<void>;
    profile: AnimaRuntimeProfile;
    retryNotice?: string;
    session?: Session;
    signal?: AbortSignal;
    suppressFailureRecord?: boolean;
  }): Promise<AgentRuntimeInput> {
    const promptContext = await this.promptContext(input.context);
    const prompt = buildCodeAgentDeliveryPrompt(input.context.item, promptContext);
    return {
      cwd: input.context.homePath,
      effects: this.effects(
        input.context,
        input.onActivity,
        input.onProviderProgress,
        input.onRuntimeStarted,
      ),
      env: runtimeEnv(input.context, this.runtime.env),
      onActivity: input.onActivity,
      prompt: input.retryNotice ? `${prompt}\n\n${input.retryNotice}` : prompt,
      providerSession: providerSessionFor(input.context, this.runtime.kind, input.session),
      itemId: input.context.item.id,
      signal: input.signal,
      suppressFailureRecord: input.suppressFailureRecord,
      systemPrompt: buildAnimaRuntimeProfile(input.profile),
      systemPromptFilePath: runtimeSystemPromptPath(input.context.agentId, this.runtime.kind),
    };
  }

  async followupInput(input: {
    activeContext: RuntimeItemContext;
    contexts: RuntimeItemContext[];
    maxPromptBytes?: number;
  }): Promise<AgentRuntimeFollowupInput> {
    const itemIds: string[] = [];
    const prompts: string[] = [];
    let promptBytes = 0;
    for (const context of input.contexts) {
      // Prefer a prepared cursor-delivery body when cut (b) is active for this item.
      const promptContext = await this.promptContext(context);
      const prompt = buildCodeAgentDeliveryPrompt(context.item, promptContext);
      const separator = prompts.length > 0 ? '\n\n' : '';
      const candidateBytes = promptBytes + Buffer.byteLength(`${separator}${prompt}`, 'utf8');
      if (
        prompts.length > 0 &&
        input.maxPromptBytes !== undefined &&
        candidateBytes > input.maxPromptBytes
      ) break;
      itemIds.push(context.item.id);
      prompts.push(prompt);
      promptBytes = candidateBytes;
    }
    return {
      activeItemId: input.activeContext.item.id,
      itemIds,
      prompt: prompts.join('\n\n'),
    };
  }

  private async promptContext(context: RuntimeItemContext): Promise<CodeAgentPromptContext> {
    const event = context.item;
    if (event.kind === 'memory_coherence') {
      const config = await defaultServerSettingsService.readConfig();
      return {
        memoryCoherence: {
          consolidationThresholdBytes: config.memoryCoherence?.consolidationThresholdBytes,
          homePath: context.homePath,
        },
      };
    }
    if (event.kind === 'reminder') {
      const agentId = context.agentId;
      const reminder = await reminderServiceForAgent(agentId).findReminder(event.reminderId);
      if (!reminder) throw new Error(`Reminder context not found: ${event.reminderId}`);
      return { reminder };
    }
    // Slack (and only Slack) may carry a cut-(b) cursor-delivery prompt body.
    if (context.cursorDelivery?.promptBody) {
      return { cursorDeliveryPromptBody: context.cursorDelivery.promptBody };
    }
    return {};
  }

  private effects(
    context: RuntimeItemContext,
    onActivity?: () => void,
    onProviderProgress?: () => void,
    onRuntimeStarted?: () => Promise<void>,
  ): AgentRuntimeEffects {
    const runtimeKind = this.runtime.kind;
    const target: RuntimeActivityTarget = {
      agentId: context.agentId,
      itemId: context.item.id,
    };
    const noteActivity = () => onActivity?.();
    const noteProviderProgress = () => {
      noteActivity();
      onProviderProgress?.();
    };
    return {
      // Maintenance sessions must not replace the agent's primary business session.
      persistProviderSession: async (session) => {
        if (context.item.kind === 'memory_coherence') return;
        await persistProviderSession(context, this.runtime.kind, session);
      },
      recordAgentText: (text, payload) => {
        noteProviderProgress();
        return recordAgentText(target, this.runtime.kind, text, payload);
      },
      recordEvent: (payload) => {
        noteActivity();
        return recordRuntimeEvent(target, this.runtime.kind, this.runtime.env, payload);
      },
      recordOutput: (stream, text) => {
        noteActivity();
        return recordRuntimeOutputChunk(target, this.runtime.kind, stream, text);
      },
      async recordUsage(usage) {
        noteActivity();
        try {
          await agentTokenUsageServiceForAgent(context.agentId).record(context.item.id, runtimeKind, usage);
        } catch (error) {
          // Accounting must not turn a completed provider request into a failed
          // user task. Storage failures remain visible in service logs.
          console.error(`Token usage record failed for ${context.agentId}/${context.item.id}:`, error);
        }
      },
      recordRuntime: async (type, payload) => {
        noteActivity();
        await recordRuntimeActivity(target, this.runtime.kind, type, payload);
        // Provider-neutral commit seam: once per run start (retries re-enter
        // commitCursorDelivery which is idempotent).
        if (type === 'runtime.started' && onRuntimeStarted) {
          await onRuntimeStarted();
        }
      },
      async recordToolFailed(payload) {
        noteActivity();
        await recordRuntimeToolFailed(target, payload);
      },
      async recordToolStarted(payload) {
        noteProviderProgress();
        await recordRuntimeToolStarted(target, payload);
      },
    };
  }
}

export function runtimeEnv(context: RuntimeItemContext, env?: Record<string, string>): NodeJS.ProcessEnv {
  const binDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), 'bin');
  const path = [binDir, env?.['PATH'] ?? process.env.PATH ?? ''].filter(Boolean).join(':');
  const { ANIMA_INBOX_ITEM_ID: _itemId, ...baseEnv } = {
    ...process.env,
    ...(env ?? {}),
  };
  return {
    ...baseEnv,
    ANIMA_AGENT_ID: context.agentId,
    ANIMA_HOME: context.stateDir,
    ANIMA_INBOX_ITEM_ID: context.item.id,
    // Seal flag for provider launch (Claude disallowed tools) and CLI denials.
    ...(context.item.kind === 'memory_coherence' ? { [ANIMA_MEMORY_COHERENCE_SEAL_ENV]: '1' } : {}),
    NO_COLOR: '1',
    PATH: path,
  };
}

function providerSessionFor(
  context: RuntimeItemContext,
  kind: string,
  session: Session = context.session,
): ProviderSession | undefined {
  // Memory-coherence seal: never resume a long-lived business session (Grant root cause).
  if (context.item.kind === 'memory_coherence') return undefined;
  const current = session.current?.kind === kind ? session.current : undefined;
  if (
    current
    && session.archived?.some((archivedSession) => archivedSession.kind === kind && archivedSession.id === current.id)
  ) {
    return undefined;
  }
  return current;
}

function runtimeSystemPromptPath(agentId: string, runtimeKind: string): string {
  return join(resolveAnimaHome(), 'run', 'agents', agentId, `${runtimeKind}-system-prompt.md`);
}

export async function persistProviderSession(
  context: RuntimeItemContext,
  kind: string,
  session: ProviderSessionRecord,
): Promise<void> {
  const updatedSession = await runtimeSessionServiceForAgent(context.agentId).persistProviderSession(kind, session);
  if (!updatedSession) return;

  const updatedProviderSession = updatedSession.current?.kind === kind ? updatedSession.current : undefined;
  if (!updatedProviderSession) return;

  context.session.current = updatedProviderSession;
  context.session.currentStartedAt = updatedSession.currentStartedAt;
}
