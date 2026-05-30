import { makeId } from '../../ids.js';
import type { SlackEvent } from '../../inbox/slack-events.js';

export function makeSlackEvent(
  input: {
    channelId: string;
    teamId: string;
    text: string;
    userId: string;
    eventId?: string;
    ts?: string;
    timestamp?: string;
  } & Partial<SlackEvent>,
): SlackEvent {
  const ts = input.ts ?? `${Date.now() / 1000}`;
  const now = input.timestamp ?? new Date().toISOString();
  return {
    id: input.eventId ?? input.id ?? makeId('evt'),
    kind: 'slack',
    receivedAt: input.receivedAt ?? now,
    handling: input.handling ?? { createdAt: now, queuedAt: now, status: 'queued', updatedAt: now },
    teamId: input.teamId,
    channelId: input.channelId,
    messageTs: ts,
    actor: { userId: input.userId, ...(input.actor ?? {}) },
    text: input.text,
    ...Object.fromEntries(
      Object.entries(input).filter(([key]) =>
        !['id', 'eventId', 'kind', 'receivedAt', 'handling', 'teamId', 'channelId', 'messageTs', 'actor', 'text', 'userId', 'ts', 'timestamp'].includes(key),
      ),
    ),
  } as SlackEvent;
}
