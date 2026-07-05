import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAnimaHome } from '../anima-home.js';
import type { RuntimeItemContext } from './types.js';
import { reminderServiceForAgent } from '../reminders/reminder.service.js';
import { FOLLOWUP_NOTE } from './delivery-notes.js';
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

export class AgentRuntimeBridge {
  private currentRunItemId: string | undefined;
  private readonly followupNoteInjectedForItemIds = new Set<string>();

  constructor(private readonly runtime: AgentRuntime) {}

  async runInput(input: {
    context: RuntimeItemContext;
    onActivity?: () => void;
    profile: AnimaRuntimeProfile;
    retryNotice?: string;
    session?: Session;
    signal?: AbortSignal;
    suppressFailureRecord?: boolean;
  }): Promise<AgentRuntimeInput> {
    this.notePrimaryRun(input.context.item.id);
    const promptContext = await this.promptContext(input.context);
    const prompt = buildCodeAgentDeliveryPrompt(input.context.item, promptContext);
    return {
      cwd: input.context.homePath,
      effects: this.effects(input.context, input.onActivity),
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
    context: RuntimeItemContext;
  }): Promise<AgentRuntimeFollowupInput> {
    const promptContext = await this.promptContext(input.context);
    const includeFollowupNote = this.shouldIncludeFollowupNote(input.activeContext.item.id);
    return {
      activeItemId: input.activeContext.item.id,
      prompt: followupPrompt(buildCodeAgentDeliveryPrompt(input.context.item, promptContext), includeFollowupNote),
      itemId: input.context.item.id,
    };
  }

  private notePrimaryRun(itemId: string): void {
    if (this.currentRunItemId === itemId) return;
    this.currentRunItemId = itemId;
    this.followupNoteInjectedForItemIds.clear();
  }

  private shouldIncludeFollowupNote(activeItemId: string): boolean {
    if (this.followupNoteInjectedForItemIds.has(activeItemId)) return false;
    this.followupNoteInjectedForItemIds.add(activeItemId);
    return true;
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
    if (event.kind !== 'reminder') return {};
    const agentId = context.agentId;
    const reminder = await reminderServiceForAgent(agentId).findReminder(event.reminderId);
    if (!reminder) throw new Error(`Reminder context not found: ${event.reminderId}`);
    return { reminder };
  }

  private effects(context: RuntimeItemContext, onActivity?: () => void): AgentRuntimeEffects {
    const target: RuntimeActivityTarget = {
      agentId: context.agentId,
      itemId: context.item.id,
    };
    const noteActivity = () => onActivity?.();
    return {
      persistProviderSession: (session) => persistProviderSession(context, this.runtime.kind, session),
      recordAgentText: (text, payload) => {
        noteActivity();
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
      recordRuntime: (type, payload) => {
        noteActivity();
        return recordRuntimeActivity(target, this.runtime.kind, type, payload);
      },
      async recordToolFailed(payload) {
        noteActivity();
        await recordRuntimeToolFailed(target, payload);
      },
      async recordToolStarted(payload) {
        noteActivity();
        await recordRuntimeToolStarted(target, payload);
      },
    };
  }
}

function followupPrompt(prompt: string, includeFollowupNote: boolean): string {
  if (!includeFollowupNote) return prompt;
  if (prompt.startsWith(FOLLOWUP_NOTE)) return prompt;
  return `${FOLLOWUP_NOTE}\n\n${prompt}`;
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
    NO_COLOR: '1',
    PATH: path,
  };
}

function providerSessionFor(
  context: RuntimeItemContext,
  kind: string,
  session: Session = context.session,
): ProviderSession | undefined {
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
