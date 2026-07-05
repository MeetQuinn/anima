// Disk schema and store for agents/<agentId>/asks.json.

import { join } from 'node:path';

import { z } from 'zod';

import { agentsDir } from './agent.store.js';
import { JsonStore } from '../json-store.js';

export const InteractiveAskOption = z.object({
  optionId: z.string(),
  label: z.string(),
}).strict();

export type InteractiveAskOption = z.infer<typeof InteractiveAskOption>;

export const InteractiveAskRecord = z.object({
  agentId: z.string(),
  allowAnyone: z.boolean().optional(),
  allowedUserIds: z.array(z.string()).optional(),
  answeredAt: z.string().optional(),
  answeredBy: z.object({
    displayName: z.string().optional(),
    handle: z.string().optional(),
    slackUserId: z.string(),
  }).strict().optional(),
  askId: z.string(),
  channelId: z.string(),
  channelName: z.string().optional(),
  chosenOptionId: z.string().optional(),
  createdAt: z.string(),
  lastInteractionAt: z.string().optional(),
  messageTs: z.string(),
  options: z.array(InteractiveAskOption).min(2).max(5),
  question: z.string(),
  status: z.enum(['pending', 'answered']),
  teamId: z.string(),
  threadTs: z.string().optional(),
}).strict();

export type InteractiveAskRecord = z.infer<typeof InteractiveAskRecord>;

const InteractiveAskFileSchema = z.record(z.string(), InteractiveAskRecord);

export type InteractiveAskFile = z.infer<typeof InteractiveAskFileSchema>;

function getInteractiveAskFileStore(agentId: string): JsonStore<InteractiveAskFile> {
  return new JsonStore<InteractiveAskFile>({
    empty: () => ({}),
    parse: InteractiveAskFileSchema.parse,
    path: () => join(agentsDir(), agentId, 'asks.json'),
  });
}

export class InteractiveAskStore {
  private readonly file: JsonStore<InteractiveAskFile>;

  constructor(agentId: string) {
    this.file = getInteractiveAskFileStore(agentId);
  }

  async list(): Promise<InteractiveAskRecord[]> {
    return Object.values(await this.file.read());
  }

  async find(askId: string): Promise<InteractiveAskRecord | undefined> {
    return (await this.file.read())[askId];
  }

  async create(ask: InteractiveAskRecord): Promise<InteractiveAskRecord> {
    await this.file.update((stored) => {
      if (stored[ask.askId]) throw new Error(`Interactive ask already exists: ${ask.askId}`);
      return {
        ...stored,
        [ask.askId]: ask,
      };
    });
    return ask;
  }

  async update(ask: InteractiveAskRecord): Promise<InteractiveAskRecord> {
    await this.file.update((stored) => {
      if (!stored[ask.askId]) throw new Error(`Interactive ask not found: ${ask.askId}`);
      return {
        ...stored,
        [ask.askId]: ask,
      };
    });
    return ask;
  }

  async pruneAnsweredBefore(cutoffIso: string): Promise<number> {
    let pruned = 0;
    await this.file.update((stored) => {
      const next: InteractiveAskFile = {};
      for (const [askId, ask] of Object.entries(stored)) {
        if (isAnsweredBefore(ask, cutoffIso)) {
          pruned += 1;
        } else {
          next[askId] = ask;
        }
      }
      return pruned > 0 ? next : stored;
    });
    return pruned;
  }
}

function isAnsweredBefore(ask: InteractiveAskRecord, cutoffIso: string): boolean {
  if (ask.status !== 'answered') return false;
  return (ask.answeredAt ?? ask.lastInteractionAt ?? ask.createdAt) < cutoffIso;
}
