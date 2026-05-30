import { errorMessage } from '../ids.js';
import type { WakeQueueService } from '../inbox/wake-queue.service.js';
import type { AgentRuntime } from './provider-contract.js';
import type { RuntimeItemContext } from './types.js';

const IDLE_CHECK_INTERVAL_FLOOR_MS = 50;
const IDLE_CHECK_INTERVAL_CAP_MS = 1_000;

export interface ActiveRunHandle {
  readonly abortController: AbortController;
  // Follow-up inbox items are completed as soon as they are appended, but their
  // processing reactions should stay visible until the active provider run ends.
  readonly appendedFollowups: RuntimeItemContext[];
  readonly startedAt: number;
  noteActivity(): void;
  release(): void;
}

export function startActiveRunControl(input: {
  abortController: AbortController;
  agentRuntime: AgentRuntime;
  idleTimeoutMs: number;
  itemId: string;
  logger: Pick<Console, 'error'>;
  queue: WakeQueueService;
}): ActiveRunHandle {
  return new ActiveRunController(input);
}

class ActiveRunController implements ActiveRunHandle {
  readonly appendedFollowups: RuntimeItemContext[] = [];
  readonly startedAt = Date.now();
  private drainRequestedAt?: string;
  private drainRequestInFlight = false;
  private lastActivityAt = this.startedAt;
  private readonly watchdog: NodeJS.Timeout;

  constructor(
    private readonly input: {
      abortController: AbortController;
      agentRuntime: AgentRuntime;
      idleTimeoutMs: number;
      itemId: string;
      logger: Pick<Console, 'error'>;
      queue: WakeQueueService;
    },
  ) {
    const tickInterval = Math.max(
      IDLE_CHECK_INTERVAL_FLOOR_MS,
      Math.min(IDLE_CHECK_INTERVAL_CAP_MS, Math.floor(input.idleTimeoutMs / 2)),
    );
    this.watchdog = setInterval(() => {
      if (input.abortController.signal.aborted) return;
      const now = Date.now();
      if (now - this.lastActivityAt >= input.idleTimeoutMs) {
        input.abortController.abort('idle_timeout');
        return;
      }
      void this.checkExternalRequests();
    }, tickInterval);
  }

  get abortController(): AbortController {
    return this.input.abortController;
  }

  noteActivity(): void {
    this.lastActivityAt = Date.now();
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
