import { join } from 'node:path';

import { z } from 'zod';

import { BackgroundInterruptedInboxItem } from '../../shared/inbox.js';
import { resolveAnimaHome } from '../anima-home.js';
import { JsonStore } from '../storage/json-store.js';

const BACKGROUND_INTERRUPTED_NOTICES_FILE = 'background-interrupted-notices.json';

const PendingBackgroundInterruptedNoticeSchema = z.object({
  agentId: z.string().min(1),
  item: BackgroundInterruptedInboxItem,
});

const BackgroundInterruptedNoticeStoreSchema = z.object({
  notices: z.record(z.string(), PendingBackgroundInterruptedNoticeSchema),
});

export type PendingBackgroundInterruptedNotice = z.infer<typeof PendingBackgroundInterruptedNoticeSchema>;

/**
 * Durable intent for background-interrupted wakes. A notice is recorded here
 * before its evidence (the previous process's health snapshot, or the handle
 * being stopped) is overwritten, and removed only once the wake queue holds it,
 * so a failed enqueue or a crash in between cannot lose it.
 */
export class BackgroundInterruptedNoticeStore {
  private readonly store: JsonStore<{ notices: Record<string, PendingBackgroundInterruptedNotice> }>;

  constructor(private readonly options: { animaHome?: string } = {}) {
    this.store = new JsonStore({
      empty: () => ({ notices: {} }),
      parse: (value) => BackgroundInterruptedNoticeStoreSchema.parse(value),
      path: () => join(this.animaHome(), 'run', BACKGROUND_INTERRUPTED_NOTICES_FILE),
      writeRoot: () => this.animaHome(),
    });
  }

  async add(notice: PendingBackgroundInterruptedNotice): Promise<void> {
    await this.store.update((current) => ({
      notices: { ...current.notices, [notice.item.id]: notice },
    }));
  }

  async list(): Promise<PendingBackgroundInterruptedNotice[]> {
    return Object.values((await this.store.read()).notices)
      .sort((a, b) => a.item.id.localeCompare(b.item.id));
  }

  async remove(itemId: string): Promise<void> {
    await this.store.update((current) => {
      if (!current.notices[itemId]) return current;
      const notices = { ...current.notices };
      delete notices[itemId];
      return { notices };
    });
  }

  private animaHome(): string {
    return this.options.animaHome ?? resolveAnimaHome();
  }
}
