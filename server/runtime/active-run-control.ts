import { isClaimableQueuedInboxItem, type InboxItem } from '../../shared/inbox.js';
import { errorMessage } from '../ids.js';
import type { WakeQueueService } from '../inbox/wake-queue.service.js';
import type { AgentRuntime } from '../providers/contract.js';
import type { RuntimeItemContext } from './types.js';

const IDLE_CHECK_INTERVAL_FLOOR_MS = 50;
const IDLE_CHECK_INTERVAL_CAP_MS = 1_000;
/**
 * How long a run may show no provider activity while a message waits for it
 * before the watchdog stops the run so the message gets an answer.
 */
export const STALL_WITH_WAITING_INPUT_MS = 10 * 60 * 1000;

export interface ActiveRunHandle {
  readonly abortController: AbortController;
  // Follow-up inbox items are completed as soon as they are appended, but their
  // processing reactions should stay visible until the active provider run ends.
  readonly appendedFollowups: RuntimeItemContext[];
  readonly itemId: string;
  readonly startedAt: number;
  /** Provider activity only; accepting a follow-up is not progress. */
  noteActivity(): void;
  /** ISO time of the provider's last activity before any abort (run start if none). */
  providerSilentSince(): string;
  release(): void;
}

interface ActiveRunControlInput {
  abortController: AbortController;
  agentRuntime: AgentRuntime;
  idleTimeoutMs: number;
  itemId: string;
  logger: Pick<Console, 'error'>;
  queue: WakeQueueService;
  stallTimeoutMs: number;
}

export function startActiveRunControl(input: ActiveRunControlInput): ActiveRunHandle {
  return new ActiveRunController(input);
}

class ActiveRunController implements ActiveRunHandle {
  readonly appendedFollowups: RuntimeItemContext[] = [];
  readonly startedAt = Date.now();
  private drainRequestedAt?: string;
  private drainRequestInFlight = false;
  private lastActivityAt = this.startedAt;
  private stallCheckInFlight = false;
  private readonly watchdog: NodeJS.Timeout;

  constructor(private readonly input: ActiveRunControlInput) {
    const tickInterval = Math.max(
      IDLE_CHECK_INTERVAL_FLOOR_MS,
      Math.min(IDLE_CHECK_INTERVAL_CAP_MS, Math.floor(Math.min(input.idleTimeoutMs, input.stallTimeoutMs) / 2)),
    );
    this.watchdog = setInterval(() => {
      if (input.abortController.signal.aborted) return;
      const silentMs = Date.now() - this.lastActivityAt;
      if (silentMs >= input.idleTimeoutMs) {
        input.abortController.abort('idle_timeout');
        return;
      }
      if (silentMs >= input.stallTimeoutMs) void this.stopIfInputWaiting();
      void this.checkExternalRequests();
    }, tickInterval);
  }

  get abortController(): AbortController {
    return this.input.abortController;
  }

  get itemId(): string {
    return this.input.itemId;
  }

  noteActivity(): void {
    // Output while the provider shuts down after an abort (a mapper flush,
    // stderr) is not progress, and must not move the mark that decides which
    // follow-ups it never reached.
    if (this.input.abortController.signal.aborted) return;
    this.lastActivityAt = Date.now();
  }

  providerSilentSince(): string {
    return new Date(this.lastActivityAt).toISOString();
  }

  // A provider can wedge inside one tool call with no events at all. When a
  // message is waiting on such a run, stop it well before the idle timeout so
  // the message gets an answer.
  private async stopIfInputWaiting(): Promise<void> {
    // A restart drain settles the item itself; do not race it with a stop.
    if (this.stallCheckInFlight || this.drainRequestInFlight) return;
    this.stallCheckInFlight = true;
    const { abortController, itemId, logger, queue } = this.input;
    try {
      const silentSince = this.providerSilentSince();
      const items = await queue.list();
      if (abortController.signal.aborted || this.providerSilentSince() !== silentSince) return;
      if (items.some((item) => isInputWaitingOn(item, itemId, silentSince))) abortController.abort('stalled');
    } catch (error) {
      logger.error(`Runtime worker stall check failed for item ${itemId}: ${errorMessage(error)}`);
    } finally {
      this.stallCheckInFlight = false;
    }
  }

  release(): void {
    clearInterval(this.watchdog);
  }

  private async checkExternalRequests(): Promise<void> {
    const { abortController, itemId, logger, queue } = this.input;
    try {
      const item = await queue.find(itemId);
      if (item?.handling.stopRequestedAt && !abortController.signal.aborted) {
        abortController.abort('user_stop');
        return;
      }
      const drainRequestedAt = item?.handling.drainRequestedAt;
      if (
        drainRequestedAt &&
        !this.drainRequestInFlight &&
        this.drainRequestedAt !== drainRequestedAt &&
        !abortController.signal.aborted
      ) {
        this.drainRequestInFlight = true;
        this.drainRequestedAt = drainRequestedAt;
        void this.drainActiveItem(item.handling.drainTimeoutMs);
      }
    } catch (error) {
      logger.error(`Runtime worker control check failed for item ${itemId}: ${errorMessage(error)}`);
    }
  }

  private async drainActiveItem(timeoutMs: number | undefined): Promise<void> {
    const { abortController, agentRuntime, itemId, logger, queue } = this.input;
    try {
      if (!agentRuntime.requestDrain) return;
      await withTimeout(
        agentRuntime.requestDrain({ activeItemId: itemId, signal: abortController.signal }),
        timeoutMs ?? 15_000,
        `Timed out waiting for item ${itemId} to reach a restart drain point`,
      );
      const current = await queue.find(itemId);
      if (current?.handling.drainRequestedAt !== this.drainRequestedAt) return;
      if (!abortController.signal.aborted) abortController.abort('restart_drain');
    } catch (error) {
      logger.error(`Runtime worker drain request failed for item ${itemId}: ${errorMessage(error)}`);
    } finally {
      this.drainRequestInFlight = false;
    }
  }
}

/**
 * A message is waiting on the active run when it was appended after the
 * provider's last activity, or is still queued behind the run.
 */
function isInputWaitingOn(item: InboxItem, activeItemId: string, silentSince: string): boolean {
  if (item.kind === 'memory_coherence') return false;
  if (item.handling.status === 'running') {
    return item.handling.appendedToItemId === activeItemId
      && item.handling.appendedAt !== undefined
      && item.handling.appendedAt >= silentSince;
  }
  return isClaimableQueuedInboxItem(item);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
