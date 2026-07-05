import { join } from 'node:path';

import { agentsDir } from './agent.store.js';
import { makeId, nowIso } from '../../ids.js';
import { DEFAULT_JSONL_ROTATE_BYTES, JsonlAppendLog } from '../jsonl-log.js';
import type { Activity, ActivityType } from '../../../shared/activity.js';

export interface ActivityRecordInput {
  createdAt?: string;
  payload?: Record<string, unknown>;
  type: ActivityType;
}

export class ActivityStore {
  constructor(private readonly agentId: string) {}

  async record(input: ActivityRecordInput): Promise<Activity> {
    const activity: Activity = {
      activityId: makeId('actv'),
      createdAt: input.createdAt ?? nowIso(),
      ...(input.payload && { payload: input.payload }),
      type: input.type,
    };
    await this.log().append(activity);
    return activity;
  }

  async readAll(): Promise<Activity[]> {
    return await this.log().readAll();
  }

  /** Read the last `n` activity records without loading the full log file. */
  async readLastN(n: number): Promise<Activity[]> {
    return this.log().readTail(n);
  }

  /**
   * Read the newest `n` records matching a predicate, scanning segments
   * newest-first and stopping as soon as `n` matches are found. Returns
   * newest-first. Avoids loading the full log when the match is recent.
   */
  async readNewestMatching(n: number, matches: (activity: Activity) => boolean): Promise<Activity[]> {
    return this.log().readNewestMatching(n, matches);
  }

  /**
   * Read the last `n` activity records with `createdAt` strictly before the
   * given ISO timestamp cursor. Used for cursor-based backward pagination.
   * Falls back to a full file read (all activities before cursor) because the
   * seek-from-end optimisation in readTail cannot efficiently skip a mid-file
   * boundary — backward pagination is rare so the full scan is acceptable.
   */
  async readBefore(beforeCreatedAt: string, n: number): Promise<Activity[]> {
    const all = await this.readAll();
    const slice = all.filter((a) => a.createdAt < beforeCreatedAt);
    return slice.slice(-n);
  }

  private log(): JsonlAppendLog<Activity> {
    const root = join(agentsDir(), this.agentId);
    return new JsonlAppendLog<Activity>(join(root, 'activity.jsonl'), {
      archiveDir: join(root, 'activity.archive'),
      maxBytes: DEFAULT_JSONL_ROTATE_BYTES,
    });
  }
}
