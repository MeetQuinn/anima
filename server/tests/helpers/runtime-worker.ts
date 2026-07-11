import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { sleep, waitFor } from './harness.js';
import { WakeQueueService, type WakeQueueEnqueueResult } from '../../inbox/wake-queue.service.js';
import { runtimeContextForItemId } from '../../runtime/context.js';
import { ReminderStore } from '../../storage/schema/reminder.store.js';
import type { InboxItem, InboxItemStatus, MemoryCoherenceInboxItem } from '../../../shared/inbox.js';
import type {
  AgentRuntime,
  AgentRuntimeCloseOptions,
  AgentRuntimeDrainInput,
  AgentRuntimeInput,
  AgentRuntimeResult,
  AgentRuntimeFollowupInput,
} from '../../providers/contract.js';
import type { RuntimeWorkerConfig, RuntimeItemContext } from '../../runtime/types.js';

type TestInboxDecision = WakeQueueEnqueueResult & { ctx: RuntimeItemContext };

export const FOLLOWUP_NOTE_PREFIX = 'Anima note: this message arrived while you were mid-task.';

export async function enqueueInbox(
  event: InboxItem,
  options: RuntimeWorkerConfig,
): Promise<TestInboxDecision> {
  await ensureTestAgentConfig(options);
  const decision = await new WakeQueueService(options.agentId).enqueue(event);
  return {
    ...decision,
    ctx: await runtimeContextForItemId(decision.item.id, options),
  };
}

export const queueFor = (agentId: string): WakeQueueService => new WakeQueueService(agentId);

export function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

export async function ensureTestAgentConfig(options: RuntimeWorkerConfig): Promise<void> {
  const agentDir = join(options.stateDir, 'agents', options.agentId);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'config.json'), `${JSON.stringify({ id: options.agentId }, null, 2)}\n`, 'utf8');
}

export function memoryCoherenceCoordinator(stateDir: string): RuntimeWorkerConfig {
  return { agentId: 'scout', homePath: join(stateDir, 'agent-home'), stateDir };
}

export async function prepareMemoryCoherenceHome(options: RuntimeWorkerConfig): Promise<void> {
  assert.ok(options.homePath, 'expected memory coherence test home path');
  await mkdir(join(options.homePath, 'notes'), { recursive: true });
  await writeFile(join(options.homePath, 'MEMORY.md'), '# Existing memory\n', 'utf8');
}

export class NullReadEnqueueQueue extends WakeQueueService {
  redrainEmptyChecks = 0;
  private injected = false;

  constructor(
    agentId: string,
    private readonly shouldInject: () => boolean,
    private readonly injectedItem: InboxItem,
  ) {
    super(agentId);
  }

  override async takeNextRunnable(
    input: Parameters<WakeQueueService['takeNextRunnable']>[0],
  ): Promise<InboxItem | undefined> {
    const item = await super.takeNextRunnable(input);
    if (item) return item;
    if (!this.injected && this.shouldInject()) {
      this.injected = true;
      await this.enqueue(this.injectedItem);
      return undefined;
    }
    if (this.injected) this.redrainEmptyChecks += 1;
    return undefined;
  }
}

export class ControlledRuntime implements AgentRuntime {
  readonly kind = 'controlled';
  readonly calls: AgentRuntimeInput[] = [];
  completed = 0;
  private readonly resolvers: Array<() => void> = [];

  constructor(readonly env?: Record<string, string>) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    await new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
    this.completed += 1;
    return { text: `completed ${input.itemId}` };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }

  async close(): Promise<void> {
    while (this.resolvers.length > 0) this.resolvers.shift()?.();
  }

  finishNext(): void {
    const resolve = this.resolvers.shift();
    assert.ok(resolve, 'Expected an active runtime call');
    resolve();
  }
}

export class StaticTextRuntime implements AgentRuntime {
  readonly kind = 'static-text';

  constructor(private readonly text: string) {}

  async run(_input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    return { text: this.text };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

export class ToolActivityRuntime implements AgentRuntime {
  readonly kind = 'tool-activity';

  constructor(
    private readonly text: string,
    private readonly toolCalls: Record<string, unknown>[],
  ) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    for (const toolCall of this.toolCalls) {
      await input.effects.recordToolStarted(toolCall);
    }
    return { text: this.text };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

export class MemoryWritingRuntime implements AgentRuntime {
  readonly kind = 'memory-writing';

  constructor(
    private readonly text: string,
    private readonly writes: Array<{ path: string; tempPath?: string; text: string }>,
    private readonly toolCalls: Record<string, unknown>[] = [],
  ) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    for (const toolCall of this.toolCalls) {
      await input.effects.recordToolStarted(toolCall);
    }
    for (const write of this.writes) {
      const destination = join(input.cwd, write.path);
      await mkdir(dirname(destination), { recursive: true });
      if (write.tempPath) {
        const tempPath = join(input.cwd, write.tempPath);
        await mkdir(dirname(tempPath), { recursive: true });
        await writeFile(tempPath, write.text, 'utf8');
        await rename(tempPath, destination);
      } else {
        await writeFile(destination, write.text, 'utf8');
      }
    }
    return { text: this.text };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

export class CloseOptionsRuntime implements AgentRuntime {
  readonly kind = 'close-options';
  readonly closeOptions: Array<AgentRuntimeCloseOptions | undefined> = [];

  async run(_input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    return {};
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }

  async close(options?: AgentRuntimeCloseOptions): Promise<void> {
    this.closeOptions.push(options);
  }
}

export class FollowupRuntime extends ControlledRuntime {
  readonly followups: AgentRuntimeFollowupInput[] = [];

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean; text: string }> {
    this.followups.push(input);
    return { accepted: true, text: `appended ${input.itemId}` };
  }
}

export class FailingFollowupRuntime implements AgentRuntime {
  readonly kind = 'failing-followup';
  readonly calls: AgentRuntimeInput[] = [];
  readonly followups: AgentRuntimeFollowupInput[] = [];
  private readonly rejecters: Array<(error: unknown) => void> = [];

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    if (this.calls.length > 1) return { text: `completed ${input.itemId}` };
    return new Promise((_, reject) => {
      this.rejecters.push(reject);
    });
  }

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean; text: string }> {
    this.followups.push(input);
    return { accepted: true, text: `appended ${input.itemId}` };
  }

  async close(): Promise<void> {
    while (this.rejecters.length > 0) this.rejecters.shift()?.(new Error('closed'));
  }

  failNext(): void {
    const reject = this.rejecters.shift();
    assert.ok(reject, 'Expected an active runtime call');
    reject(new Error('parent turn failed'));
  }
}

export class RejectingFollowupRuntime extends ControlledRuntime {
  readonly followups: AgentRuntimeFollowupInput[] = [];

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    this.followups.push(input);
    return { accepted: false };
  }
}

export class NotReadyFollowupRuntime extends ControlledRuntime {
  readonly followups: AgentRuntimeFollowupInput[] = [];
  attempts = 0;
  ready = false;

  async appendToActiveRun(input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean; retryable?: boolean; text?: string }> {
    this.attempts += 1;
    if (!this.ready) return { accepted: false, retryable: true };
    this.followups.push(input);
    return { accepted: true, text: `appended ${input.itemId}` };
  }
}

export async function waitForInboxItemStatus(
  agentId: string,
  itemId: string,
  status: InboxItemStatus,
  timeoutMs = 1000,
): Promise<void> {
  await waitFor(async () => {
    const item = (await queueFor(agentId).list()).find((candidate) => candidate.id === itemId);
    return item?.handling.status === status;
  }, {
    description: `item ${itemId} to reach ${status}`,
    timeoutMs,
  });
}

export async function waitForInboxItemRemoved(
  agentId: string,
  itemId: string,
  timeoutMs = 1000,
): Promise<void> {
  await waitFor(async () => {
    const item = await queueFor(agentId).find(itemId);
    return !item;
  }, {
    description: `item ${itemId} to be removed`,
    timeoutMs,
  });
}

export async function waitForInboxItemAppendedTo(
  agentId: string,
  itemId: string,
  parentItemId: string,
  timeoutMs = 1000,
): Promise<void> {
  await waitFor(async () => {
    const item = await queueFor(agentId).find(itemId);
    return item?.handling.status === 'running' && item.handling.appendedToItemId === parentItemId;
  }, {
    description: `item ${itemId} to append to ${parentItemId}`,
    timeoutMs,
  });
}

export async function seedReminder(agentId: string, reminderId: string, timestamp: string): Promise<void> {
  await new ReminderStore(agentId).create({
    createdAt: timestamp,
    firedCount: 0,
    instructions: 'Reminder test instructions',
    nextDueAt: timestamp,
    reminderId,
    schedule: { kind: 'once' },
    status: 'scheduled',
    title: 'Reminder test',
    updatedAt: timestamp,
  });
}

export function makeMemoryCoherenceInboxItem(input: {
  scheduledSlotAt: string;
  timestamp: string;
}): MemoryCoherenceInboxItem {
  return {
    handling: {
      createdAt: input.timestamp,
      queuedAt: input.timestamp,
      status: 'queued',
      updatedAt: input.timestamp,
    },
    id: 'memory-coherence:scout:2026-06-22',
    kind: 'memory_coherence',
    receivedAt: input.timestamp,
    scheduledSlotAt: input.scheduledSlotAt,
    scheduledSlotLabel: '05:47 agent-local',
  };
}

export const silentLogger = {
  error: () => {},
  log: () => {},
};

export class AbortableRuntime implements AgentRuntime {
  readonly kind = 'abortable';
  readonly calls: AgentRuntimeInput[] = [];

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    return new Promise((_, reject) => {
      if (input.signal?.aborted) {
        reject(new Error(`aborted: ${String(input.signal.reason)}`));
        return;
      }
      input.signal?.addEventListener('abort', () => {
        reject(new Error(`aborted: ${String(input.signal?.reason)}`));
      }, { once: true });
    });
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

export class DrainableRuntime extends AbortableRuntime {
  readonly drainCalls: AgentRuntimeDrainInput[] = [];

  async requestDrain(input: AgentRuntimeDrainInput): Promise<void> {
    this.drainCalls.push(input);
  }
}

export class ActivityBeforeFinishRuntime implements AgentRuntime {
  readonly kind = 'activity-runtime';
  readonly calls: AgentRuntimeInput[] = [];

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    // fixed delay: keep the fake runtime active long enough to observe mid-run activity.
    await sleep(150);
    if (input.signal?.aborted) throw new Error(`aborted: ${String(input.signal.reason)}`);
    await input.effects.recordOutput('stdout', 'still running');
    // fixed delay: keep the fake runtime active after output so drain/close behavior can be observed.
    await sleep(150);
    if (input.signal?.aborted) throw new Error(`aborted: ${String(input.signal.reason)}`);
    return { text: 'finished after activity' };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

export class CrashThenSuccessRuntime implements AgentRuntime {
  readonly kind = 'codex-cli';
  readonly calls: AgentRuntimeInput[] = [];

  constructor(private readonly failuresBeforeSuccess: number) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    if (this.calls.length <= this.failuresBeforeSuccess) {
      throw new Error('Codex app-server runtime exited before completing active requests');
    }
    return { text: 'recovered' };
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}

export class FatalProviderRuntime implements AgentRuntime {
  readonly kind = 'claude-code';
  readonly calls: AgentRuntimeInput[] = [];

  constructor(private readonly message = 'Invalid API key') {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResult> {
    this.calls.push(input);
    throw new Error(this.message);
  }

  async appendToActiveRun(_input: AgentRuntimeFollowupInput): Promise<{ accepted: boolean }> {
    return { accepted: false };
  }
}
