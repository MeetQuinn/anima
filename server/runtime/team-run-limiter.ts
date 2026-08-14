import { DEFAULT_MAX_CONCURRENT_AGENT_RUNS } from '../../shared/server-settings.js';

export const TEAM_ACTIVE_RUN_LIMIT = DEFAULT_MAX_CONCURRENT_AGENT_RUNS;

type ReleaseRunSlot = () => void;
type WaitingRun = (release: ReleaseRunSlot) => void;

export class TeamRunLimiter {
  private activeRuns = 0;
  private readonly waitingRuns: WaitingRun[] = [];
  private limit: number;

  constructor(limit = TEAM_ACTIVE_RUN_LIMIT) {
    this.limit = validateLimit(limit);
  }

  currentLimit(): number {
    return this.limit;
  }

  setLimit(limit: number): void {
    this.limit = validateLimit(limit);
    this.admitWaitingRuns();
  }

  acquire(): Promise<ReleaseRunSlot> {
    return new Promise((resolve) => {
      this.waitingRuns.push(resolve);
      this.admitWaitingRuns();
    });
  }

  private admitWaitingRuns(): void {
    while (this.activeRuns < this.limit) {
      const next = this.waitingRuns.shift();
      if (!next) return;
      this.activeRuns += 1;
      next(this.releaseOnce());
    }
  }

  private releaseOnce(): ReleaseRunSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRuns -= 1;
      this.admitWaitingRuns();
    };
  }
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Team run limit must be a positive integer, received ${limit}`);
  }
  return limit;
}
