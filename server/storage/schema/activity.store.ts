import { join } from 'node:path';

import { agentsDir } from './agent.store.js';
import { makeId, nowIso } from '../../ids.js';
import { DEFAULT_JSONL_ROTATE_BYTES, JsonlAppendLog, type PositionedRecord } from '../jsonl-log.js';
import type { Activity, ActivityType, AgentActivityAfterPage, AgentActivityFeedPage } from '../../../shared/activity.js';
import {
  encodeHistoryCursor, resolveHistoryAfter, resolveHistoryQuery, type HistoryFilters,
} from '../history-cursor.js';

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

  async readPage(input: { before?: string; cursor?: string; limit: number }): Promise<AgentActivityFeedPage> {
    const { anchor, filters } = resolveHistoryQuery({
      agentId: this.agentId, kind: 'activity', before: input.before, cursor: input.cursor,
    });
    const { rows, hasMore } = await this.log().readPage({
      limit: input.limit, anchor, idOf: (event) => event.activityId, matches: activityMatcher(filters),
    });
    const last = rows.at(-1);
    const head = rows[0];
    return {
      events: rows.map(({ record }) => record).reverse(),
      nextCursor: hasMore && last ? this.cursorAt(filters, last) : null,
      // Rows come newest first, so the first page's first row is the head.
      ...(anchor ? {} : { headCursor: head ? this.cursorAt(filters, head) : null }),
    };
  }

  /** Events appended after `after`, oldest first, in the cursor's scope. */
  async readAfter(input: { after: string; before?: string; cursor?: string; limit: number }): Promise<AgentActivityAfterPage> {
    const { anchor, filters } = resolveHistoryAfter({
      agentId: this.agentId, kind: 'activity', after: input.after, before: input.before, cursor: input.cursor,
    });
    const { rows, hasMore } = await this.log().readPage({
      direction: 'newer', limit: input.limit, anchor, idOf: (event) => event.activityId,
      matches: activityMatcher(filters),
    });
    const last = rows.at(-1);
    return {
      readAfter: true,
      events: rows.map(({ record }) => record),
      afterCursor: last ? this.cursorAt(filters, last) : null,
      hasMore,
    };
  }

  private cursorAt(filters: HistoryFilters, row: PositionedRecord<Activity>): string {
    return encodeHistoryCursor({ k: 'activity', a: this.agentId, f: filters, p: row.position, id: row.record.activityId });
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

  async readNewestUntil(shouldStop: (activity: Activity) => boolean): Promise<Activity[]> {
    return this.log().readNewestUntil(shouldStop);
  }

  /**
   * Read the last `n` activity records with `createdAt` strictly before the
   * given ISO time filter. Paged feeds use readPage's append-position cursor.
   * Returns oldest-first within the page.
   */
  async readBefore(beforeCreatedAt: string, n: number): Promise<Activity[]> {
    return (await this.readNewestMatching(n, (a) => a.createdAt < beforeCreatedAt)).reverse();
  }

  private log(): JsonlAppendLog<Activity> {
    const root = join(agentsDir(), this.agentId);
    return new JsonlAppendLog<Activity>(join(root, 'activity.jsonl'), {
      archiveDir: join(root, 'activity.archive'),
      maxBytes: DEFAULT_JSONL_ROTATE_BYTES,
    });
  }
}

function activityMatcher(filters: HistoryFilters): (event: Activity) => boolean {
  return (event) => !filters.beforeTime || event.createdAt < filters.beforeTime;
}
