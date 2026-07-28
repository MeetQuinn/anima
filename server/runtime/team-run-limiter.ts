export const TEAM_ACTIVE_RUN_LIMIT = 5;

type ReleaseRunSlot = () => void;
type WaitingRun = (release: ReleaseRunSlot) => void;

export class TeamRunLimiter {
  private activeRuns = 0;
  private readonly waitingRuns: WaitingRun[] = [];

  constructor(private readonly limit = TEAM_ACTIVE_RUN_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Team run limit must be a positive integer, received ${limit}`);
    }
  }

  acquire(): Promise<ReleaseRunSlot> {
    if (this.activeRuns < this.limit) {
      this.activeRuns += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve) => {
      this.waitingRuns.push(resolve);
    });
  }

  private releaseOnce(): ReleaseRunSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waitingRuns.shift();
      if (next) {
        next(this.releaseOnce());
        return;
      }
      this.activeRuns -= 1;
    };
  }
}
