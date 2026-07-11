import { join } from 'node:path';

import { z } from 'zod';

import { JsonStore } from '../json-store.js';
import { agentsDir } from './agent.store.js';

export const ProviderSession = z.object({
  id: z.string(),
  kind: z.string(),
  updatedAt: z.string(),
});

export type ProviderSession = z.infer<typeof ProviderSession>;

export const ArchivedProviderSession = ProviderSession.extend({
  archivedAt: z.string(),
  archivedBy: z.enum(['operator', 'recovery']),
  note: z.string().optional(),
});

export type ArchivedProviderSession = z.infer<typeof ArchivedProviderSession>;

const ProviderSessionStats = z.object({
  activityId: z.string(),
  autoCompactWindow: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  contextWindow: z.number().optional(),
  createdAt: z.string(),
  currentContextTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  model: z.string().optional(),
  outputTokens: z.number().optional(),
  runtimeKind: z.string().optional(),
  serviceTier: z.string().optional(),
  sessionCompactionCount: z.number().optional(),
  sessionTokenUsage: z.number().optional(),
  terminalReason: z.string().optional(),
  totalTokens: z.number().optional(),
  usedTokens: z.number().optional(),
});

export const Session = z.object({
  archived: z.array(ArchivedProviderSession).optional(),
  createdAt: z.string(),
  current: ProviderSession.optional(),
  currentStartedAt: z.string().optional(),
  latestProviderStats: ProviderSessionStats.optional(),
  lifetimeTokens: z.number().optional(),
  updatedAt: z.string(),
});

export type Session = z.infer<typeof Session>;

const SessionFile = Session.partial();

function getSessionFileStore(agentId: string): JsonStore<Partial<Session>> {
  return new JsonStore<Partial<Session>>({
    empty: () => ({}),
    parse: SessionFile.parse,
    path: () => join(agentsDir(), agentId, 'sessions.json'),
  });
}

export class SessionStore {
  private readonly file: JsonStore<Partial<Session>>;

  constructor(agentId: string) {
    this.file = getSessionFileStore(agentId);
  }

  async read(): Promise<Session | undefined> {
    return storedSession(await this.file.read());
  }

  async write(session: Session): Promise<Session> {
    const next = Session.parse(session);
    await this.file.write(next);
    return next;
  }

  async update(
    op: (current: Session | undefined) => Session | undefined | Promise<Session | undefined>,
  ): Promise<Session | undefined> {
    let next: Session | undefined;
    await this.file.update(async (stored) => {
      const current = storedSession(stored);
      const result = await op(current);
      if (!result) {
        next = current;
        return stored;
      }
      next = Session.parse(result);
      return next;
    });
    return next;
  }
}

function storedSession(session: Partial<Session>): Session | undefined {
  return session.createdAt ? session as Session : undefined;
}

export function currentProviderSessionStartedAt(session: Session): string {
  const latestArchivedAt = (session.archived ?? [])
    .map((archived) => archived.archivedAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.localeCompare(a))[0];
  return latestArchivedAt ?? session.createdAt;
}
